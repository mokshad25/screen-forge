"""
Context store: the machine contexts the API generates and validates against.

Fixture contexts in contracts/fixtures/ are the factory defaults. Anything that
happens at runtime -- a machine change, a machine imported from OPC UA -- is
written to SQLite (store.py) and wins over the fixture on the next start.

Every context entering the store, from a file or from a network import, is
checked against contracts/machine-context.schema.json first. A context is data
from outside the system; a malformed one is refused, not patched.
"""

import json
from pathlib import Path

import jsonschema

import store

ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ROOT / "contracts" / "fixtures"
CONTEXT_SCHEMA_PATH = ROOT / "contracts" / "machine-context.schema.json"
CONTEXT_FILE_PREFIX = "context."

with open(CONTEXT_SCHEMA_PATH) as _f:
    _CONTEXT_VALIDATOR = jsonschema.Draft7Validator(json.load(_f))


class ContextNotFoundError(Exception):
    """Raised when someone asks for an asset_id we don't have a context for."""


class InvalidContextError(ValueError):
    """Raised when a context does not satisfy the machine-context schema or its own references."""


def context_problems(context: dict) -> list[str]:
    """Every reason this context can't be used, or [] when it is sound."""
    problems = [
        "$" + "".join(f"[{p!r}]" for p in e.absolute_path) + f": {e.message}"
        for e in _CONTEXT_VALIDATOR.iter_errors(context)
    ]
    if problems:
        return problems

    tags = {t["name"]: t for t in context["tags"]}
    if len(tags) != len(context["tags"]):
        problems.append("tag names are not unique")
    alarm_ids = [a["id"] for a in context["alarms"]]
    if len(set(alarm_ids)) != len(alarm_ids):
        problems.append("alarm ids are not unique")
    devices = {c["device"] for c in context["comms"]}

    for alarm in context["alarms"]:
        tag = tags.get(alarm["tag"])
        if tag is None:
            problems.append(f"alarm {alarm['id']} watches unknown tag {alarm['tag']!r}")
            continue
        value = alarm["condition"]["value"]
        if tag["type"] == "bool" and not isinstance(value, bool):
            problems.append(f"alarm {alarm['id']} compares bool tag {tag['name']} with a number")
        if tag["type"] == "analog" and isinstance(value, bool):
            problems.append(f"alarm {alarm['id']} compares analog tag {tag['name']} with true/false")
        for related in alarm.get("related_tags", []):
            if related not in tags:
                problems.append(f"alarm {alarm['id']} playbook names unknown tag {related!r}")
    for comm in context["comms"]:
        if comm["health_tag"] not in tags:
            problems.append(f"comms {comm['device']} health_tag {comm['health_tag']!r} is not a tag")
    for tag in context["tags"]:
        rng = tag.get("range")
        if rng and rng["low"] >= rng["high"]:
            problems.append(f"tag {tag['name']} range low >= high")
        if rng and tag["type"] == "bool":
            problems.append(f"tag {tag['name']} is bool but has a range")
        src = tag.get("source")
        if src and src.get("device") and src["device"] not in devices:
            problems.append(f"tag {tag['name']} reads through unknown device {src['device']!r}")
        if src and src["protocol"] == "connection" and src["address"] not in devices:
            problems.append(f"tag {tag['name']} reports link state of unknown device {src['address']!r}")
    return problems


def check_context(context: dict) -> None:
    problems = context_problems(context)
    if problems:
        raise InvalidContextError("; ".join(problems))


def _fixture_contexts() -> dict[str, dict]:
    contexts = {}
    for path in sorted(FIXTURES_DIR.glob(f"{CONTEXT_FILE_PREFIX}*.json")):
        with open(path) as f:
            data = json.load(f)
        check_context(data)
        contexts[data["asset_id"]] = data
    return contexts


_CONTEXTS: dict[str, dict] = {}
_HISTORY: dict[str, dict[str, dict]] = {}
_FIXTURES: dict[str, dict] = {}


def load() -> None:
    """(Re)load contexts: fixtures first, then whatever the database says is current."""
    _CONTEXTS.clear()
    _HISTORY.clear()
    _FIXTURES.clear()
    _FIXTURES.update(_fixture_contexts())

    persisted = store.current_contexts()
    for asset_id, ctx in _FIXTURES.items():
        if asset_id not in persisted:
            store.save_context(ctx, origin="fixture")
            persisted[asset_id] = ctx

    for asset_id, ctx in persisted.items():
        if context_problems(ctx):
            # A stored context written by an older schema version: fall back
            # to the fixture rather than serve something the validator rejects.
            if asset_id in _FIXTURES:
                ctx = _FIXTURES[asset_id]
                store.save_context(ctx, origin="fixture")
            else:
                continue
        _CONTEXTS[asset_id] = ctx
        _HISTORY[asset_id] = {
            v: c for v, c in store.context_versions(asset_id).items() if not context_problems(c)
        }
        _HISTORY[asset_id][ctx["context_version"]] = ctx


def remember_version(context: dict) -> None:
    """Record a context under its version, so it can be diffed against later."""
    _HISTORY.setdefault(context["asset_id"], {})[context["context_version"]] = context


def get_version(asset_id: str, context_version: str) -> dict | None:
    """A previously seen version of a context, or None if we never held it."""
    return _HISTORY.get(asset_id, {}).get(context_version)


def list_asset_ids() -> list[str]:
    return list(_CONTEXTS.keys())


def get_context(asset_id: str) -> dict:
    if asset_id not in _CONTEXTS:
        raise ContextNotFoundError(
            f"No machine context found for asset_id='{asset_id}'. Known asset_ids: {list_asset_ids()}"
        )
    return _CONTEXTS[asset_id]


def all_contexts() -> list[dict]:
    return list(_CONTEXTS.values())


def reload_context(asset_id: str, new_context: dict, origin: str = "runtime") -> None:
    """Make new_context current for asset_id, after checking it."""
    check_context(new_context)
    if new_context["asset_id"] != asset_id:
        raise InvalidContextError(f"context is for {new_context['asset_id']}, not {asset_id}")
    _CONTEXTS[asset_id] = new_context
    remember_version(new_context)
    store.save_context(new_context, origin=origin)


def register_context(context: dict, origin: str) -> dict:
    """Add or replace a machine (e.g. imported over OPC UA)."""
    reload_context(context["asset_id"], context, origin=origin)
    return context


def is_fixture_asset(asset_id: str) -> bool:
    return asset_id in _FIXTURES


def reset_context(asset_id: str) -> dict:
    """Put a fixture machine back exactly as it is on disk, undoing runtime changes."""
    if asset_id not in _FIXTURES:
        raise ContextNotFoundError(
            f"No machine context file on disk for asset_id='{asset_id}'. Known asset_ids: {list_asset_ids()}"
        )
    fresh = _fixture_contexts()[asset_id]
    _FIXTURES[asset_id] = fresh
    _CONTEXTS[asset_id] = fresh
    remember_version(fresh)
    store.save_context(fresh, origin="fixture")
    return fresh


load()
