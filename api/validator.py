"""
Screen-spec validator.

Checks a candidate screen specification in exactly three layers, in this
order, stopping at the first layer that fails:

    LAYER 1  "schema"      -- JSON Schema validation against the frozen
                             contracts/screen-spec.schema.json
    LAYER 2  "whitelist"   -- every bound tag / alarm id / device must exist
                             in that asset's machine context, each component
                             must bind exactly one thing, component ids must
                             be unique, and a bound tag must not be a
                             write-access (command) tag
    LAYER 3  "read_only"   -- permissions.mode must be "read_only", and no
                             component type may be write-capable

The layers are deliberately independent: layer 2 re-checks the component
type enum even though layer 1's schema already restricts it, so that each
layer is defensible on its own in a demo.

This module NEVER auto-repairs a spec. A spec either passes a layer cleanly
or that layer fails, and we return a structured error naming what failed.
"""

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import jsonschema

import context_store

# Same path pattern as context_store.py: build it relative to THIS file, so
# it works no matter what the current working directory is when the API runs.
#   repo-root/
#     contracts/screen-spec.schema.json
#     api/validator.py   <- this file
SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent / "contracts" / "screen-spec.schema.json"
)

# Loaded exactly once, when this module is first imported.
with open(SCHEMA_PATH, "r") as _f:
    _SCREEN_SPEC_SCHEMA = json.load(_f)

# Build the validator once too. Draft7Validator matches the "$schema" line in
# the contract file and lets us collect *all* schema errors, not just the
# first one.
_SCHEMA_VALIDATOR = jsonschema.Draft7Validator(_SCREEN_SPEC_SCHEMA)

# Independent copy of the allowed component types. Layer 1 also enforces this
# via the schema enum; layer 2 re-checks it on purpose (see module docstring).
ALLOWED_COMPONENT_TYPES = {
    "alarm_banner",
    "status_indicator",
    "gauge",
    "trend",
    "nav_tile",
    "comms_health",
}

# Component types that can write to a tag. Empty today -- no component in the
# registry performs writes. Defined anyway so layer 3 stays meaningful the
# day someone adds a write-capable component type.
WRITE_CAPABLE_TYPES: set[str] = set()

# The four binding fields; a component must carry exactly one of them.
_BIND_FIELDS = ("bind_tag", "bind_alarms", "bind_device", "bind_asset")


@dataclass
class ValidationResult:
    """Outcome of validate_spec().

    valid        -- True only if all three layers passed.
    failed_layer -- "schema", "whitelist", "read_only", or None when valid.
    errors       -- human-readable strings, each naming the specific
                    field/value that failed (never a generic message).
    """

    valid: bool
    failed_layer: str | None = None
    errors: list[str] = field(default_factory=list)


def _layer1_schema(spec: dict) -> list[str]:
    """Return a list of schema errors (empty list == layer passed)."""
    errors: list[str] = []
    for err in sorted(_SCHEMA_VALIDATOR.iter_errors(spec), key=lambda e: list(e.absolute_path)):
        location = "$" + "".join(f"[{part!r}]" for part in err.absolute_path)
        errors.append(f"schema: {location}: {err.message}")
    return errors


def _layer2_whitelist(spec: dict) -> list[str]:
    """Return a list of whitelist errors (empty list == layer passed)."""
    errors: list[str] = []

    asset_id = spec["asset_id"]
    try:
        context = context_store.get_context(asset_id)
    except context_store.ContextNotFoundError:
        return [
            f"whitelist: asset_id {asset_id!r} has no machine context "
            f"(known asset_ids: {context_store.list_asset_ids()})"
        ]

    known_tags = {t["name"] for t in context["tags"]}
    known_alarms = {a["id"] for a in context["alarms"]}
    known_devices = {c["device"] for c in context["comms"]}
    # Tag name -> its declared access ("read" or "write"), so a display
    # component can be rejected for binding a write-only command tag.
    tag_access = {t["name"]: t["access"] for t in context["tags"]}

    # Component ids must be unique within a screen; a repeated id makes the
    # rendered screen and any later id-based lookup ambiguous.
    id_counts = Counter(c.get("id") for c in spec["components"])
    for dup_id, count in id_counts.items():
        if count > 1:
            errors.append(
                f"duplicate component id {dup_id!r} appears {count} times"
            )

    for component in spec["components"]:
        cid = component.get("id", "<no id>")

        ctype = component.get("type")
        if ctype not in ALLOWED_COMPONENT_TYPES:
            errors.append(
                f"component {cid}: type {ctype!r} is not an allowed component type "
                f"({sorted(ALLOWED_COMPONENT_TYPES)})"
            )

        present = [f for f in _BIND_FIELDS if f in component]
        if len(present) != 1:
            if not present:
                errors.append(
                    f"component {cid}: must bind exactly one of "
                    f"{list(_BIND_FIELDS)}, but binds none"
                )
            else:
                errors.append(
                    f"component {cid}: must bind exactly one of "
                    f"{list(_BIND_FIELDS)}, but binds {present}"
                )
            # Without a single clear binding there's nothing more to check
            # for this component.
            continue

        if "bind_tag" in component:
            tag = component["bind_tag"]
            if tag not in known_tags:
                errors.append(
                    f"component {cid}: bind_tag {tag!r} not found in context tags "
                    f"for asset {asset_id}"
                )
            elif tag_access.get(tag) == "write":
                errors.append(
                    f"component {cid}: bind_tag {tag!r} is a write-access tag; "
                    "display components may not bind command tags"
                )

        if "bind_alarms" in component:
            for alarm_id in component["bind_alarms"]:
                if alarm_id not in known_alarms:
                    errors.append(
                        f"component {cid}: bind_alarms id {alarm_id!r} not found in "
                        f"context alarms for asset {asset_id}"
                    )

        if "bind_device" in component:
            device = component["bind_device"]
            if device not in known_devices:
                errors.append(
                    f"component {cid}: bind_device {device!r} not found in context "
                    f"comms devices for asset {asset_id}"
                )

        if "bind_asset" in component:
            # nav_tile jumps to a *different* machine, so its target is
            # checked against every known asset_id (across all contexts),
            # not against this asset's own context.
            target_asset = component["bind_asset"]
            if target_asset not in context_store.list_asset_ids():
                errors.append(
                    f"component {cid}: bind_asset {target_asset!r} is not a known "
                    f"asset_id (known asset_ids: {context_store.list_asset_ids()})"
                )

    return errors


def _layer3_read_only(spec: dict) -> list[str]:
    """Return a list of read-only-gate errors (empty list == layer passed)."""
    errors: list[str] = []

    mode = spec["permissions"]["mode"]
    if mode != "read_only":
        errors.append(
            f"read_only: permissions.mode is {mode!r}, must be 'read_only' "
            "(MVP is read-only)"
        )

    for component in spec["components"]:
        cid = component.get("id", "<no id>")
        ctype = component.get("type")
        if ctype in WRITE_CAPABLE_TYPES:
            errors.append(
                f"component {cid}: type {ctype!r} is write-capable and not allowed "
                "while permissions.mode is read_only"
            )

    return errors


def validate_spec(spec: dict) -> ValidationResult:
    """Validate a candidate screen spec through all three layers in order.

    Stops at the first layer that produces any error. Returns a
    ValidationResult; never raises for an invalid spec, and never mutates or
    repairs the input.
    """
    schema_errors = _layer1_schema(spec)
    if schema_errors:
        return ValidationResult(valid=False, failed_layer="schema", errors=schema_errors)

    whitelist_errors = _layer2_whitelist(spec)
    if whitelist_errors:
        return ValidationResult(
            valid=False, failed_layer="whitelist", errors=whitelist_errors
        )

    read_only_errors = _layer3_read_only(spec)
    if read_only_errors:
        return ValidationResult(
            valid=False, failed_layer="read_only", errors=read_only_errors
        )

    return ValidationResult(valid=True, failed_layer=None, errors=[])
