"""
Reconciler -- what happens to an existing screen when its machine changes.

A screen records the context_version it was built against. When a context is
bumped at runtime (a sensor added, a tag renamed), every screen built against
the old version is potentially stale. This module answers two questions about
one such screen:

    1. What changed between the version it was built against and now?
    2. Do all of its bindings still exist?

Both answers live here rather than in /web on purpose. /web only holds the
version STRING its screen was built with, so it cannot diff anything by
itself; and invariant 4 says the whitelist is derived from the machine
context by the API, so a second binding-checker in the renderer would be a
second source of truth that can drift from validator.py.

Nothing here repairs a spec. It reports; regenerating is the caller's call.
"""

import context_store
import validator

# The tag the machine-change demo adds to a context at runtime. Kept here
# beside the bump logic rather than in a fixture, because contracts/ is frozen
# and this is a runtime event, not a contract.
DEMO_TAG = {
    "name": "Vibration_PV",
    "type": "analog",
    "unit": "mm/s",
    "access": "read",
}


def _names(items: list[dict], key: str) -> set[str]:
    return {item[key] for item in items}


def diff_contexts(old: dict, new: dict) -> dict:
    """What changed between two versions of the same machine context."""
    return {
        "from_version": old["context_version"],
        "to_version": new["context_version"],
        "tags_added": sorted(_names(new["tags"], "name") - _names(old["tags"], "name")),
        "tags_removed": sorted(_names(old["tags"], "name") - _names(new["tags"], "name")),
        "alarms_added": sorted(_names(new["alarms"], "id") - _names(old["alarms"], "id")),
        "alarms_removed": sorted(_names(old["alarms"], "id") - _names(new["alarms"], "id")),
        "comms_added": sorted(_names(new["comms"], "device") - _names(old["comms"], "device")),
        "comms_removed": sorted(_names(old["comms"], "device") - _names(new["comms"], "device")),
    }


def _broken_bindings(spec: dict, context: dict) -> list[dict]:
    """
    Every binding in the spec that no longer resolves against the context,
    named down to the component and field so the renderer can point at it.
    """
    known = {
        "bind_tag": _names(context["tags"], "name"),
        "bind_alarms": _names(context["alarms"], "id"),
        "bind_device": _names(context["comms"], "device"),
        "bind_asset": set(context_store.list_asset_ids()),
    }

    broken = []
    for component in spec.get("components", []):
        for field, valid_values in known.items():
            if field not in component:
                continue
            value = component[field]
            missing = [v for v in value if v not in valid_values] if isinstance(value, list) \
                else ([] if value in valid_values else [value])
            for gone in missing:
                broken.append({
                    "component_id": component.get("id"),
                    "component_type": component.get("type"),
                    "field": field,
                    "value": gone,
                    "reason": f"{gone!r} is not in {context['context_version']}",
                })
    return broken


def reconcile(spec: dict) -> dict:
    """
    Check one screen spec against the machine context as it stands now.

    Returns a report; never modifies the spec. `stale` means the screen was
    built against an older context_version. `broken_bindings` means it binds
    something that no longer exists -- a screen can be stale without being
    broken, which is the ordinary case when a sensor is simply added.
    """
    asset_id = spec["asset_id"]
    current = context_store.get_context(asset_id)
    built_against = spec.get("context_version")

    old = context_store.get_version(asset_id, built_against)
    changes = diff_contexts(old, current) if old and old is not current else None

    broken = _broken_bindings(spec, current)
    result = validator.validate_spec(spec)

    return {
        "asset_id": asset_id,
        "spec_context_version": built_against,
        "current_context_version": current["context_version"],
        "stale": built_against != current["context_version"],
        "changes": changes,
        "broken_bindings": broken,
        "still_valid": result.valid,
        "errors": result.errors,
    }


def _next_version(context_version: str) -> str:
    """'chiller1@v1' -> 'chiller1@v2'. Falls back to appending when unparseable."""
    prefix, _, version = context_version.rpartition("@v")
    if prefix and version.isdigit():
        return f"{prefix}@v{int(version) + 1}"
    return f"{context_version}+1"


def bump_context(asset_id: str) -> dict:
    """
    The machine change itself: add the demo sensor and move the version on.

    Returns the same report shape as a diff, plus the new context, so the
    caller can show what happened without asking a second question. Adding
    the tag twice is refused rather than silently doing nothing -- reset the
    context first (that's what rehearsing the demo repeatedly needs).
    """
    current = context_store.get_context(asset_id)

    if DEMO_TAG["name"] in _names(current["tags"], "name"):
        return {
            "changed": False,
            "reason": (
                f"{DEMO_TAG['name']} is already on {asset_id} at "
                f"{current['context_version']}. POST /context/{asset_id}/reset "
                "to put it back to the version on disk, then bump again."
            ),
            "context_version": current["context_version"],
            "context": current,
        }

    updated = {
        **current,
        "context_version": _next_version(current["context_version"]),
        "tags": [*current["tags"], dict(DEMO_TAG)],
    }
    context_store.reload_context(asset_id, updated)

    return {
        "changed": True,
        "context_version": updated["context_version"],
        "changes": diff_contexts(current, updated),
        "context": updated,
    }
