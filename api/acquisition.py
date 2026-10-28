"""
Live data acquisition.

One background loop reads every machine once per tick, runs the alarm engine,
and publishes the result to every connected UI over Server-Sent Events. Before
this, each browser poll advanced the simulator, so two open tabs ran the plant
at double speed and showed different values.

Two sources, chosen by SCREENFORGE_TAG_SOURCE:
  sim   (default)  the in-process simulator (tag_simulator.py)
  live             each tag's `source` in the machine context: OPC UA via
                   asyncua, Modbus TCP via pymodbus, and `connection` tags
                   that report whether a device link is up

Every value carries a quality: "good", or "bad" when its device can't be
reached. A bad value is the last one read, held and flagged -- never a
simulated stand-in. Showing invented numbers as if they were the plant is
worse than showing that the link is down.

Nothing in this module writes to a device. The OPC UA client only reads node
values; the Modbus client only issues function codes 1 (read coils) and 3
(read holding registers).
"""

import asyncio
import logging
import os
import time
from urllib.parse import urlparse

import alarms
import context_store
import store
import tag_simulator

log = logging.getLogger("screenforge.acquisition")

TICK_SECONDS = float(os.environ.get("SCREENFORGE_TICK_SECONDS", "1.0"))
RETRY_SECONDS = 3.0
READ_TIMEOUT = 2.0


def tag_source_mode() -> str:
    return os.environ.get("SCREENFORGE_TAG_SOURCE", "sim").strip().lower()


def _host(host: str) -> str:
    # In docker-compose the plant is reachable as "plant", not 127.0.0.1.
    override = os.environ.get("SCREENFORGE_PLANT_HOST")
    return override if override and host in ("127.0.0.1", "localhost") else host


class _Link:
    """Connection bookkeeping shared by both protocol clients."""

    def __init__(self, device: str):
        self.device = device
        self.up = False
        self.next_attempt = 0.0
        self.last_error: str | None = None

    def failed(self, err: Exception) -> None:
        if self.up:
            log.warning("link %s down: %s", self.device, err)
        self.up = False
        self.last_error = f"{type(err).__name__}: {err}" if str(err) else type(err).__name__
        self.next_attempt = time.time() + RETRY_SECONDS

    def may_try(self) -> bool:
        return self.up or time.time() >= self.next_attempt


class OpcUaLink(_Link):
    def __init__(self, device: str, endpoint: str):
        super().__init__(device)
        parsed = urlparse(endpoint)
        self.url = endpoint.replace(parsed.hostname or "", _host(parsed.hostname or ""), 1)
        self.client = None

    async def read(self, node_ids: list[str]) -> list:
        from asyncua import Client  # imported lazily: sim mode never needs it

        if not self.may_try():
            raise ConnectionError(self.last_error or "waiting to retry")
        try:
            if self.client is None:
                self.client = Client(self.url, timeout=READ_TIMEOUT)
                await asyncio.wait_for(self.client.connect(), READ_TIMEOUT * 2)
            nodes = [self.client.get_node(n) for n in node_ids]
            values = await asyncio.wait_for(self.client.read_values(nodes), READ_TIMEOUT)
            if not self.up:
                log.info("link %s up (%s)", self.device, self.url)
            self.up = True
            return values
        except Exception as e:
            await self.close()
            self.failed(e)
            raise

    async def close(self) -> None:
        client, self.client = self.client, None
        if client is not None:
            try:
                await asyncio.wait_for(client.disconnect(), 1.0)
            except Exception:
                pass


class ModbusLink(_Link):
    def __init__(self, device: str, endpoint: str):
        super().__init__(device)
        parsed = urlparse(endpoint)  # modbus-tcp://host:port/unit
        self.host = _host(parsed.hostname or "127.0.0.1")
        self.port = parsed.port or 502
        self.unit = int((parsed.path or "/1").strip("/") or 1)
        self.client = None

    async def read(self, requests: list[tuple[str, int]]) -> list[int | bool]:
        """requests: [("coil"|"hr", address)] -> raw values, in order."""
        from pymodbus.client import AsyncModbusTcpClient

        if not self.may_try():
            raise ConnectionError(self.last_error or "waiting to retry")
        try:
            if self.client is None or not self.client.connected:
                self.client = AsyncModbusTcpClient(self.host, port=self.port, timeout=READ_TIMEOUT, retries=0)
                if not await self.client.connect():
                    raise ConnectionError(f"cannot connect to {self.host}:{self.port}")
            out = []
            for kind, address in requests:
                if kind == "coil":
                    rr = await self.client.read_coils(address, count=1, device_id=self.unit)
                    if rr.isError():
                        raise ConnectionError(f"coil {address}: {rr}")
                    out.append(bool(rr.bits[0]))
                else:
                    rr = await self.client.read_holding_registers(address, count=1, device_id=self.unit)
                    if rr.isError():
                        raise ConnectionError(f"register {address}: {rr}")
                    raw = rr.registers[0]
                    out.append(raw - 0x10000 if raw & 0x8000 else raw)  # signed INT
            if not self.up:
                log.info("link %s up (%s:%s unit %s)", self.device, self.host, self.port, self.unit)
            self.up = True
            return out
        except Exception as e:
            await self.close()
            self.failed(e)
            raise

    async def close(self) -> None:
        client, self.client = self.client, None
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


class LiveReader:
    """Reads one machine's tags from wherever its context says they live."""

    def __init__(self):
        self.links: dict[str, _Link] = {}
        self.last: dict[str, dict] = {}

    def _link(self, comm: dict) -> _Link | None:
        key = f"{comm['device']}|{comm['endpoint']}"
        if key not in self.links:
            endpoint = comm["endpoint"]
            if endpoint.startswith("opc.tcp://"):
                self.links[key] = OpcUaLink(comm["device"], endpoint)
            elif endpoint.startswith("modbus-tcp://"):
                self.links[key] = ModbusLink(comm["device"], endpoint)
            else:
                return None  # a protocol ScreenForge does not speak (e.g. EtherNet/IP)
        return self.links[key]

    async def read(self, ctx: dict) -> tuple[dict, dict]:
        asset = ctx["asset_id"]
        last = self.last.setdefault(asset, {})
        comms = {c["device"]: c for c in ctx["comms"]}
        values: dict = {}
        quality: dict = {}

        by_device: dict[str, list[dict]] = {}
        for tag in ctx["tags"]:
            src = tag.get("source")
            if src and src["protocol"] in ("opcua", "modbus") and src.get("device") in comms:
                by_device.setdefault(src["device"], []).append(tag)

        device_ok: dict[str, bool] = {}
        for device, tags in by_device.items():
            link = self._link(comms[device])
            if link is None:
                device_ok[device] = False
                continue
            try:
                if isinstance(link, OpcUaLink):
                    raw = await link.read([t["source"]["address"] for t in tags])
                else:
                    reqs = []
                    for t in tags:
                        addr = t["source"]["address"]
                        reqs.append(("coil", int(addr.split(":", 1)[1])) if addr.startswith("coil:") else ("hr", int(addr)))
                    raw = await link.read(reqs)
                for tag, value in zip(tags, raw):
                    if tag["type"] == "bool":
                        value = bool(value)
                    else:
                        value = round(float(value) * float(tag["source"].get("scale", 1.0)), 3)
                    values[tag["name"]] = last[tag["name"]] = value
                    quality[tag["name"]] = "good"
                device_ok[device] = True
            except Exception:
                device_ok[device] = False
                for tag in tags:
                    values[tag["name"]] = last.get(tag["name"])
                    quality[tag["name"]] = "bad"

        for tag in ctx["tags"]:
            name = tag["name"]
            src = tag.get("source")
            if name in values:
                continue
            if src and src["protocol"] == "connection":
                device = src["address"]
                if device not in device_ok and device in comms:
                    link = self._link(comms[device])
                    device_ok[device] = bool(link and link.up)
                values[name] = device_ok.get(device, False)
                quality[name] = "good"
            else:
                values[name] = None
                quality[name] = "n/a" if tag["access"] == "write" else "bad"
        return values, quality

    def link_status(self) -> list[dict]:
        return [
            {"device": l.device, "up": l.up, "error": None if l.up else l.last_error}
            for l in self.links.values()
        ]

    async def close(self) -> None:
        for link in self.links.values():
            await link.close()  # type: ignore[attr-defined]


class Hub:
    """Fan-out of events to every connected SSE client."""

    def __init__(self):
        self.queues: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.queues.discard(q)

    def publish(self, event: dict) -> None:
        for q in list(self.queues):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # a stalled client misses ticks; it never blocks the loop


hub = Hub()
_reader = LiveReader()
_snapshots: dict[str, dict] = {}
_task: asyncio.Task | None = None

# Called with (context, transition) for every alarm transition. main.py hooks
# the troubleshooting-screen builder in here, so this module stays about data.
on_alarm_transition = None


def _snapshot(ctx: dict, values: dict, quality: dict) -> dict:
    alarm_states = alarms.snapshot(ctx)
    return {
        "asset_id": ctx["asset_id"],
        "context_version": ctx["context_version"],
        "timestamp": time.time(),
        "source": tag_source_mode(),
        "tags": values,
        "quality": quality,
        "alarms": {aid: s["active"] for aid, s in alarm_states.items()},
        "alarm_states": alarm_states,
    }


async def tick() -> None:
    """Read every machine once, update alarms, publish."""
    mode = tag_source_mode()
    for ctx in context_store.all_contexts():
        if mode == "live":
            values, quality = await _reader.read(ctx)
        else:
            values = tag_simulator.step(ctx["asset_id"])
            quality = {t["name"]: "good" for t in ctx["tags"]}
        transitions = alarms.update(ctx, values, quality)
        snap = _snapshot(ctx, values, quality)
        _snapshots[ctx["asset_id"]] = snap
        for transition in transitions:
            store.log_event(f"alarm_{transition['event']}", ctx["asset_id"], **transition)
            extra = on_alarm_transition(ctx, transition) if on_alarm_transition else None
            hub.publish({"type": "alarm", "asset_id": ctx["asset_id"], **transition, **(extra or {})})
        hub.publish({"type": "tags", **snap})


async def _run() -> None:
    while True:
        started = time.time()
        try:
            await tick()
        except Exception:
            log.exception("acquisition tick failed")
        await asyncio.sleep(max(0.05, TICK_SECONDS - (time.time() - started)))


def start() -> None:
    global _task
    if _task is None:
        _task = asyncio.get_running_loop().create_task(_run())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
    await _reader.close()


def latest(asset_id: str) -> dict:
    """The most recent snapshot. Without a running loop (tests, scripts), take one sim reading now."""
    ctx = context_store.get_context(asset_id)
    snap = _snapshots.get(asset_id)
    if snap is not None and snap["context_version"] == ctx["context_version"] and _task is not None:
        return snap
    if tag_source_mode() == "live" and snap is not None:
        return snap
    values = tag_simulator.step(asset_id)
    quality = {t["name"]: "good" for t in ctx["tags"]}
    alarms.update(ctx, values, quality)
    snap = _snapshot(ctx, values, quality)
    _snapshots[asset_id] = snap
    return snap


def status() -> dict:
    return {
        "mode": tag_source_mode(),
        "running": _task is not None,
        "links": _reader.link_status() if tag_source_mode() == "live" else [],
    }
