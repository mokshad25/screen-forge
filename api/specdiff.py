"""
What changed between two versions of a screen.

After a conversational edit the operator should see exactly what moved: a
model told to "make the trend bigger" that also quietly drops a gauge has done
something the operator didn't ask for, and they need to be able to see it.

Components are matched by what they show (type + binding), not by id, so an
edit that renumbers ids still reads as "unchanged" where nothing moved.
"""


def binding_of(component: dict) -> str:
    for key in ("bind_tag", "bind_device", "bind_asset"):
        if key in component:
            return str(component[key])
    for key in ("bind_tags", "bind_alarms"):
        if key in component:
            return ", ".join(component[key])
    return ""


def _key(component: dict) -> tuple[str, str]:
    return component.get("type", ""), binding_of(component)


def _label(component: dict) -> str:
    return f"{component.get('type', '?').replace('_', ' ')} ({binding_of(component)})"


def diff_specs(old: dict, new: dict) -> dict:
    old_by_key = {_key(c): c for c in old.get("components", [])}
    new_by_key = {_key(c): c for c in new.get("components", [])}

    added = [_label(new_by_key[k]) for k in new_by_key if k not in old_by_key]
    removed = [_label(old_by_key[k]) for k in old_by_key if k not in new_by_key]
    changed = []
    for k in new_by_key.keys() & old_by_key.keys():
        before, after = old_by_key[k], new_by_key[k]
        notes = []
        if before.get("size_hint") != after.get("size_hint"):
            notes.append(f"size {before.get('size_hint')} -> {after.get('size_hint')}")
        if before.get("priority") != after.get("priority"):
            notes.append(f"priority {before.get('priority')} -> {after.get('priority')}")
        if before.get("min_panel", "small") != after.get("min_panel", "small"):
            notes.append(f"min panel {before.get('min_panel', 'small')} -> {after.get('min_panel', 'small')}")
        if notes:
            changed.append({"component": _label(after), "changes": notes})

    summary = [f"added {a}" for a in added] + [f"removed {r}" for r in removed] + [
        f"{c['component']}: {', '.join(c['changes'])}" for c in sorted(changed, key=lambda c: c["component"])
    ]
    if old.get("title") != new.get("title"):
        summary.append(f"title: {old.get('title')!r} -> {new.get('title')!r}")
    return {
        "added": added,
        "removed": removed,
        "changed": sorted(changed, key=lambda c: c["component"]),
        "summary": summary,
        "unchanged": not summary,
    }
