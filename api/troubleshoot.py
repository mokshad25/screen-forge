"""
Alarm-triggered troubleshooting screens.

When an alarm raises, the operator gets a screen built for working THAT alarm,
in well under a millisecond and with no model in the loop. In an upset nobody
should wait 15 seconds for an LLM, and nobody should get a different screen
for the same alarm twice. Same alarm, same machine context -> same screen.

What goes on it, in priority order:
  1. the alarm banner: this alarm, then anything else active on the machine
  2. the alarmed signal now: a gauge (analog) or status light (bool)
  3. the alarmed signal over time: a trend
  4. the alarm's playbook (alarms[].related_tags in the machine context),
     or, when an engineer hasn't written one, signals on the same equipment
     or with the same unit
  5. a same-unit comparison trend, when there is one to draw
     (condenser vs evaporator pressure)
  6. health of the comms link the alarmed signal is read through -- is this
     the process, or is it the sensor's network?

The result is an ordinary screen spec and goes through the same validator as
everything the model writes. If a context ever produced an invalid one, that
is a bug and it raises rather than shipping a broken screen.
"""

import re
import time

import alarms
import validator

# Words in tag names that say what kind of measurement it is, not which piece
# of equipment. Two tags sharing only these are not related.
_GENERIC_TOKENS = {
    "pv", "sp", "status", "runstatus", "temp", "temperature", "pressure", "level",
    "health", "comm", "sensor", "value", "speed", "dp", "flow", "air", "water",
}

MAX_RELATED = 4


def _tokens(tag_name: str) -> set[str]:
    return {t for t in re.split(r"[_\W]+", tag_name.lower()) if t and t not in _GENERIC_TOKENS and not t.isdigit()}


def related_tags(ctx: dict, alarm: dict) -> list[str]:
    """The playbook if the context has one, else a same-equipment / same-unit guess."""
    readable = {t["name"]: t for t in ctx["tags"] if t["access"] == "read"}
    playbook = [t for t in alarm.get("related_tags", []) if t in readable and t != alarm["tag"]]
    if playbook:
        return playbook[:MAX_RELATED]

    health_tags = {c["health_tag"] for c in ctx["comms"]}
    target = readable.get(alarm["tag"], {})
    target_tokens = _tokens(alarm["tag"])
    scored = []
    for name, tag in readable.items():
        if name == alarm["tag"] or name in health_tags:
            continue
        score = 2 * len(_tokens(name) & target_tokens)
        if tag.get("unit") and tag.get("unit") == target.get("unit"):
            score += 1
        if score:
            scored.append((-score, name))
    return [name for _, name in sorted(scored)][:MAX_RELATED]


def _comms_for(ctx: dict, tag_name: str) -> list[str]:
    tag = next((t for t in ctx["tags"] if t["name"] == tag_name), {})
    device = (tag.get("source") or {}).get("device")
    devices = [c["device"] for c in ctx["comms"]]
    if device in devices:
        return [device]
    return devices[:2]


def build_alarm_screen(ctx: dict, alarm_id: str, now: float | None = None) -> dict:
    alarm = next((a for a in ctx["alarms"] if a["id"] == alarm_id), None)
    if alarm is None:
        raise KeyError(f"{alarm_id} is not an alarm on {ctx['asset_id']}")

    tags = {t["name"]: t for t in ctx["tags"]}
    target = tags[alarm["tag"]]
    is_analog = target["type"] == "analog"

    others = [a for a in alarms.active_ids(ctx) if a != alarm_id]
    components: list[dict] = [
        {"type": "alarm_banner", "bind_alarms": [alarm_id, *others], "size_hint": "wide", "min_panel": "small"},
    ]
    if is_analog:
        components.append({"type": "gauge", "bind_tag": alarm["tag"], "size_hint": "medium", "min_panel": "small"})
        components.append({"type": "trend", "bind_tag": alarm["tag"], "size_hint": "wide", "min_panel": "small"})
    else:
        components.append({"type": "status_indicator", "bind_tag": alarm["tag"], "size_hint": "compact", "min_panel": "small"})

    related = related_tags(ctx, alarm)
    for name in related:
        tag = tags[name]
        kind = "numeric_readout" if tag["type"] == "analog" else "status_indicator"
        components.append({"type": kind, "bind_tag": name, "size_hint": "compact"})

    if is_analog:
        same_unit = [n for n in related if tags[n]["type"] == "analog" and tags[n].get("unit") == target.get("unit")]
        if same_unit:
            components.append({
                "type": "multi_trend", "bind_tags": [alarm["tag"], *same_unit][:4],
                "size_hint": "wide", "min_panel": "medium",
            })

    for device in _comms_for(ctx, alarm["tag"]):
        components.append({"type": "comms_health", "bind_device": device, "size_hint": "compact"})

    for i, component in enumerate(components[:12], start=1):
        component["id"] = f"c{i}"
        component["priority"] = i
    stamp = int((now or time.time()) * 1000)
    spec = {
        "screen_id": f"alarm_{alarm_id.lower()}_{stamp}",
        "title": f"{alarm['desc']}, {ctx['asset_hierarchy'][-1]}"[:80],
        "asset_id": ctx["asset_id"],
        "context_version": ctx["context_version"],
        "origin": {"kind": "alarm", "alarm_id": alarm_id},
        "components": [
            {k: c[k] for k in ("id", "type", "bind_tag", "bind_tags", "bind_alarms", "bind_device",
                               "priority", "size_hint", "min_panel") if k in c}
            for c in components[:12]
        ],
        "permissions": {"mode": "read_only"},
    }
    result = validator.validate_spec(spec)
    if not result.valid:
        raise RuntimeError(f"troubleshooting screen for {alarm_id} failed validation: {result.errors}")
    return spec
