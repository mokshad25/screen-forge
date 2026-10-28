"""
Build a machine context by browsing an OPC UA server.

Onboarding a machine used to mean a hand-written JSON file and a code change
for asset detection. With this, an engineer points ScreenForge at the plant's
OPC UA server and every asset on it becomes a machine context: tags with
their real engineering units and ranges (the standard EngineeringUnits and
EURange properties), whether each node is writable, alarms and their
playbooks, and the comms link the values arrive over.

What it browses (the information model plant_sim/server.py documents):
    Objects/Plant/<Asset>               AssetId, AssetHierarchy, Aliases, Device
    Objects/Plant/<Asset>/<Tag>         variables, with EngineeringUnits, EURange, Description
    Objects/Plant/<Asset>/Alarms/<Id>   Desc, Priority, Tag, Op, Limit, Related

Security: everything read from the server is untrusted input. Endpoints are
limited to an allowlist (SCREENFORGE_OPCUA_ALLOW, default local only), names
must be plain identifiers (the machine-context schema enforces it), and the
resulting context is fully schema-checked before it is used. A node that
reports itself writable is recorded with access "write", which the validator
then refuses to let any screen bind.
"""

import asyncio
import os
import re
from urllib.parse import urlparse

from asyncua import Client, ua

import context_store

DEFAULT_ALLOW = "127.0.0.1:4840,localhost:4840,plant:4840"
TIMEOUT = 4.0
_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


class ImportRefused(ValueError):
    """The endpoint or what it serves can't be imported."""


def check_endpoint(endpoint: str) -> str:
    parsed = urlparse(endpoint or "")
    if parsed.scheme != "opc.tcp" or not parsed.hostname:
        raise ImportRefused("endpoint must look like opc.tcp://host:port/path")
    allowed = {
        a.strip().lower()
        for a in os.environ.get("SCREENFORGE_OPCUA_ALLOW", DEFAULT_ALLOW).split(",")
        if a.strip()
    }
    hostport = f"{parsed.hostname.lower()}:{parsed.port or 4840}"
    if hostport not in allowed:
        raise ImportRefused(
            f"{hostport} is not on the OPC UA allowlist ({', '.join(sorted(allowed))}). "
            "Add it to SCREENFORGE_OPCUA_ALLOW to import from it."
        )
    return endpoint


async def _props(node) -> dict:
    out = {}
    for child in await node.get_properties():
        name = (await child.read_browse_name()).Name
        out[name] = await child.read_value()
    return out


async def _plant_assets(client: Client) -> list:
    objects = client.nodes.objects
    for child in await objects.get_children():
        if (await child.read_browse_name()).Name == "Plant":
            return await child.get_children()
    raise ImportRefused("the server has no Objects/Plant folder to import from")


async def list_assets(endpoint: str) -> list[dict]:
    check_endpoint(endpoint)
    async with Client(endpoint, timeout=TIMEOUT) as client:
        out = []
        for node in await _plant_assets(client):
            props = await _props(node)
            asset_id = props.get("AssetId")
            if not asset_id:
                continue
            out.append({
                "asset_id": asset_id,
                "folder": (await node.read_browse_name()).Name,
                "name": (props.get("AssetHierarchy") or [asset_id])[-1],
                "known": asset_id in context_store.list_asset_ids(),
            })
        return out


def _writable(access_level: int) -> bool:
    return bool(access_level & ua.AccessLevel.CurrentWrite.mask)


async def _build_context(endpoint: str, node) -> dict:
    props = await _props(node)
    asset_id = props["AssetId"]
    device = props.get("Device") or "OPCUA_Server"
    if not _NAME.match(device):
        raise ImportRefused(f"device name {device!r} is not a plain identifier")
    health_tag = f"{device}_Comm_Health"[:64]

    tags: list[dict] = []
    alarms: list[dict] = []
    for child in await node.get_children():
        bname = (await child.read_browse_name()).Name
        node_class = await child.read_node_class()
        if node_class == ua.NodeClass.Variable:
            if child in await node.get_properties():
                continue
            if not _NAME.match(bname):
                raise ImportRefused(f"tag name {bname!r} is not a plain identifier")
            dtype = await child.read_data_type_as_variant_type()
            access = await child.read_attribute(ua.AttributeIds.AccessLevel)
            vprops = await _props(child)
            tag: dict = {
                "name": bname,
                "type": "bool" if dtype == ua.VariantType.Boolean else "analog",
                "access": "write" if _writable(access.Value.Value) else "read",
                "source": {"protocol": "opcua", "device": device, "address": child.nodeid.to_string()},
            }
            desc = vprops.get("Description")
            if isinstance(desc, str) and desc:
                tag["description"] = desc[:120]
            eu = vprops.get("EngineeringUnits")
            if eu is not None and getattr(eu, "DisplayName", None) and eu.DisplayName.Text:
                tag["unit"] = eu.DisplayName.Text[:16]
            rng = vprops.get("EURange")
            if tag["type"] == "analog" and rng is not None and rng.Low < rng.High:
                tag["range"] = {"low": rng.Low, "high": rng.High}
            tags.append(tag)
        elif bname == "Alarms":
            for alarm_node in await child.get_children():
                a = await _props(alarm_node)
                alarm = {
                    "id": (await alarm_node.read_browse_name()).Name,
                    "desc": str(a.get("Desc", ""))[:80],
                    "priority": a.get("Priority"),
                    "tag": a.get("Tag"),
                    "condition": {"op": a.get("Op"), "value": a.get("Limit")},
                }
                related = [r for r in (a.get("Related") or []) if r]
                if related:
                    alarm["related_tags"] = related
                alarms.append(alarm)

    tags.append({
        "name": health_tag, "type": "bool", "access": "read",
        "description": f"{device} link healthy",
        "source": {"protocol": "connection", "address": device},
    })
    hierarchy = [str(h) for h in (props.get("AssetHierarchy") or [asset_id]) if h]
    context = {
        "asset_id": asset_id,
        "context_version": f"{asset_id.split('.')[-1]}@v1",
        "asset_hierarchy": hierarchy,
        "aliases": [str(a)[:40] for a in (props.get("Aliases") or []) if a],
        "tags": tags,
        "io": {},
        "alarms": alarms,
        "comms": [{"device": device, "protocol": "OPC UA", "endpoint": endpoint, "health_tag": health_tag}],
    }
    return context


def _next_version(existing: dict) -> str:
    prefix, _, num = existing["context_version"].rpartition("@v")
    return f"{prefix}@v{int(num) + 1}" if prefix and num.isdigit() else existing["context_version"] + "+1"


async def import_asset(endpoint: str, asset_id: str) -> dict:
    """Browse one asset and register it. Returns {context, created, changed}."""
    check_endpoint(endpoint)
    async with Client(endpoint, timeout=TIMEOUT) as client:
        for node in await _plant_assets(client):
            props = await _props(node)
            if props.get("AssetId") == asset_id:
                context = await _build_context(endpoint, node)
                break
        else:
            raise ImportRefused(f"{asset_id} is not served by {endpoint}")

    problems = context_store.context_problems(context)
    if problems:
        raise ImportRefused("imported context is not valid: " + "; ".join(problems[:5]))

    if context_store.is_fixture_asset(asset_id):
        raise ImportRefused(
            f"{asset_id} is already configured from a fixture; importing would replace "
            "its Modbus tags with only what this server exposes"
        )

    existing = None
    if asset_id in context_store.list_asset_ids():
        existing = context_store.get_context(asset_id)
        same = {k: v for k, v in existing.items() if k != "context_version"} == \
               {k: v for k, v in context.items() if k != "context_version"}
        if same:
            return {"context": existing, "created": False, "changed": False}
        context["context_version"] = _next_version(existing)

    context_store.register_context(context, origin=f"opcua:{endpoint}")
    return {"context": context, "created": existing is None, "changed": True}


def run(coro):
    """Run an import coroutine from sync code (tests, CLI)."""
    return asyncio.run(coro)
