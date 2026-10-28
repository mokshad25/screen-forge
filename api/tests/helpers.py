"""Small helpers shared by tests."""

def without_tag(context: dict, name: str, version: str) -> dict:
    """The context as it would be if a tag were removed from the machine: the
    tag goes, and so does every alarm watching it and every playbook mention."""
    return {
        **context,
        "context_version": version,
        "tags": [t for t in context["tags"] if t["name"] != name],
        "alarms": [
            {**a, "related_tags": [r for r in a.get("related_tags", []) if r != name]}
            for a in context["alarms"] if a["tag"] != name
        ],
    }
