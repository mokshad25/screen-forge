"""
Alarm engine.

Alarm conditions live in the machine context (alarms[].condition), so the
same rule decides an alarm whether values come from the simulator, OPC UA or
Modbus. This module turns a set of tag values into alarm states and the
transitions between them (raised / cleared).

Two rules borrowed from real alarm systems (ISA-18.2):
  * A tag with bad quality neither raises nor clears its alarm. A dropped
    link is not evidence that the pressure came down, so the alarm holds its
    last state and is flagged `quality: "bad"`.
  * Acknowledging is the operator saying "I've seen it". It is recorded in
    ScreenForge's own log and changes nothing on the machine.
"""

import operator
import time
from dataclasses import dataclass, field

_OPS = {
    ">": operator.gt,
    ">=": operator.ge,
    "<": operator.lt,
    "<=": operator.le,
    "==": operator.eq,
    "!=": operator.ne,
}

PRIORITY_RANK = {"Critical": 1, "High": 2, "Warning": 3}


def condition_holds(condition: dict, value) -> bool:
    """True when `value <op> condition.value`. None (no reading) never holds."""
    if value is None:
        return False
    target = condition["value"]
    if isinstance(target, bool):
        return _OPS[condition["op"]](bool(value), target)
    if isinstance(value, bool):
        return False
    return bool(_OPS[condition["op"]](float(value), float(target)))


def evaluate_conditions(context: dict, values: dict) -> dict[str, bool]:
    """Stateless: {alarm_id: active} for one set of values."""
    return {
        alarm["id"]: condition_holds(alarm["condition"], values.get(alarm["tag"]))
        for alarm in context["alarms"]
    }


@dataclass
class AlarmState:
    active: bool = False
    since: float | None = None
    acked: bool = False
    quality: str = "good"


@dataclass
class AssetAlarms:
    states: dict[str, AlarmState] = field(default_factory=dict)


_ASSETS: dict[str, AssetAlarms] = {}


def reset(asset_id: str | None = None) -> None:
    if asset_id is None:
        _ASSETS.clear()
    else:
        _ASSETS.pop(asset_id, None)


def update(context: dict, values: dict, quality: dict | None = None, now: float | None = None) -> list[dict]:
    """
    Advance the alarm states of one asset with a fresh set of values.

    Returns the transitions this produced, oldest first:
        {"alarm_id", "event": "raised"|"cleared", "priority", "desc", "tag", "value", "ts"}
    """
    now = now or time.time()
    quality = quality or {}
    asset = _ASSETS.setdefault(context["asset_id"], AssetAlarms())
    known = {a["id"] for a in context["alarms"]}
    for gone in set(asset.states) - known:
        del asset.states[gone]

    transitions = []
    for alarm in context["alarms"]:
        state = asset.states.setdefault(alarm["id"], AlarmState())
        tag_quality = quality.get(alarm["tag"], "good")
        state.quality = tag_quality
        if tag_quality != "good":
            continue  # hold the last known state; see module docstring

        value = values.get(alarm["tag"])
        active = condition_holds(alarm["condition"], value)
        if active == state.active:
            continue
        state.active = active
        if active:
            state.since = now
            state.acked = False
        transitions.append({
            "alarm_id": alarm["id"],
            "event": "raised" if active else "cleared",
            "priority": alarm["priority"],
            "desc": alarm["desc"],
            "tag": alarm["tag"],
            "value": value,
            "ts": now,
        })
    return transitions


def acknowledge(asset_id: str, alarm_id: str) -> bool:
    """Mark an active alarm as seen. Returns False if it isn't active."""
    state = _ASSETS.get(asset_id, AssetAlarms()).states.get(alarm_id)
    if state is None or not state.active:
        return False
    state.acked = True
    return True


def snapshot(context: dict) -> dict[str, dict]:
    """Every alarm on this asset with its current state, for the API and the UI."""
    asset = _ASSETS.get(context["asset_id"], AssetAlarms())
    out = {}
    for alarm in context["alarms"]:
        state = asset.states.get(alarm["id"], AlarmState())
        out[alarm["id"]] = {
            "active": state.active,
            "since": state.since,
            "acked": state.acked,
            "quality": state.quality,
            "priority": alarm["priority"],
            "desc": alarm["desc"],
            "tag": alarm["tag"],
        }
    return out


def active_ids(context: dict) -> list[str]:
    """Active alarm ids on this asset, most severe first."""
    snap = snapshot(context)
    active = [aid for aid, s in snap.items() if s["active"]]
    return sorted(active, key=lambda aid: (PRIORITY_RANK[snap[aid]["priority"]], snap[aid]["since"] or 0))
