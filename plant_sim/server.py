"""
The simulated plant: one OPC UA server, two Modbus TCP devices, and a small
HTTP control port for demos.

    python -m plant_sim            (from the repo root)

    OPC UA      opc.tcp://0.0.0.0:4840/screenforge   BMS gateway: Chiller 1 + AHU 1
    Modbus TCP  0.0.0.0:5020 unit 1                  PLC1 on Conveyor A
    Modbus TCP  0.0.0.0:5021 unit 1                  Chiller 1 compressor VFD
    HTTP        0.0.0.0:8090                         demo control (faults, links)

Register and node addresses come from the machine contexts in
contracts/fixtures, the way a real plant's tag export would define them.

OPC UA information model (what POST /context/import on the API browses):
    Objects/Plant/<Asset>                 object, properties AssetId,
                                          AssetHierarchy, Aliases, Device
    Objects/Plant/<Asset>/<Tag>           variable ns=2;s=<Asset>.<Tag>, with
                                          Description, EngineeringUnits, EURange
    Objects/Plant/<Asset>/Alarms/<Id>     object, properties Desc, Priority,
                                          Tag, Op, Limit, Related
"""

import asyncio
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from asyncua import Server, ua
from pymodbus.constants import ExcCodes
from pymodbus.simulator import DataType, SimData, SimDevice
from pymodbus.server import ModbusTcpServer

from .model import PlantModel

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "contracts" / "fixtures"
HERE = Path(__file__).resolve().parent

OPCUA_PORT = int(os.environ.get("PLANT_OPCUA_PORT", "4840"))
CONTROL_PORT = int(os.environ.get("PLANT_CONTROL_PORT", "8090"))
BIND = os.environ.get("PLANT_BIND", "0.0.0.0")
TICK_SECONDS = 0.5

log = logging.getLogger("plant_sim")


def _load(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def _port_of(endpoint: str) -> int:
    # "modbus-tcp://127.0.0.1:5020/1" -> 5020
    return int(endpoint.split("://", 1)[1].split("/", 1)[0].rsplit(":", 1)[1])


def _encode_register(value: float, scale: float) -> int:
    raw = int(round(float(value) / scale))
    raw = max(-32768, min(32767, raw))
    return raw & 0xFFFF  # two's complement, as a PLC would store a signed INT


class ModbusDevice:
    """
    One Modbus TCP device whose link can be pulled and restored.

    Values are filled in at read time from the latest process values, through
    pymodbus' SimDevice action hook. Write requests are refused and logged:
    nothing in ScreenForge should ever send one, and if something did, the
    plant log is where it would show up.
    """

    WRITE_CODES = {5, 6, 15, 16, 22, 23}

    def __init__(self, name: str, port: int, registers: dict[str, tuple[int, float]], coils: dict[str, int]):
        self.name = name
        self.port = port
        self.registers = registers  # tag -> (address, scale)
        self.coils = coils          # tag -> address
        self.values: dict = {}
        self.writes_refused = 0
        size = max([a for a, _ in registers.values()] + list(coils.values()) + [0]) + 2
        self.device = SimDevice(
            id=1,
            simdata=(
                [SimData(0, count=size, values=False, datatype=DataType.BITS)],      # coils
                [SimData(0, count=size, values=False, datatype=DataType.BITS)],      # discrete inputs
                [SimData(0, count=size, values=0, datatype=DataType.REGISTERS)],     # holding registers
                [SimData(0, count=size, values=0, datatype=DataType.REGISTERS)],     # input registers
            ),
            action=self._on_access,
        )
        self.server: ModbusTcpServer | None = None
        self.task: asyncio.Task | None = None

    async def _on_access(self, function_code, start_address, address, count, current_registers, set_values):
        if function_code in self.WRITE_CODES:
            self.writes_refused += 1
            log.warning("modbus %s: refused write fc=%s addr=%s", self.name, function_code, address)
            return ExcCodes.ILLEGAL_FUNCTION
        if function_code == 3:
            for tag, (reg, scale) in self.registers.items():
                i = reg - start_address
                if 0 <= i < len(current_registers) and tag in self.values:
                    current_registers[i] = _encode_register(self.values[tag], scale)
        elif function_code == 1:
            # Coils are packed 16 to a register: coil N is bit N % 16 of register N // 16.
            for tag, coil in self.coils.items():
                i = coil // 16 - start_address
                if 0 <= i < len(current_registers) and tag in self.values:
                    mask = 1 << (coil % 16)
                    if self.values[tag]:
                        current_registers[i] |= mask
                    else:
                        current_registers[i] &= ~mask & 0xFFFF
        return None

    @property
    def up(self) -> bool:
        return self.server is not None

    async def start(self) -> None:
        if self.server is not None:
            return
        self.server = ModbusTcpServer(self.device, address=(BIND, self.port))
        self.task = asyncio.create_task(self.server.serve_forever())
        log.info("modbus %s up on :%d", self.name, self.port)

    async def stop(self) -> None:
        if self.server is None:
            return
        await self.server.shutdown()
        self.server = None
        log.info("modbus %s link pulled", self.name)

    async def write(self, values: dict) -> None:
        self.values = values


def _modbus_devices() -> dict[str, ModbusDevice]:
    devices: dict[str, ModbusDevice] = {}
    for path in sorted(FIXTURES.glob("context.*.json")):
        ctx = _load(path)
        endpoints = {c["device"]: c["endpoint"] for c in ctx["comms"] if c["endpoint"].startswith("modbus")}
        for device, endpoint in endpoints.items():
            regs, coils = {}, {}
            for tag in ctx["tags"]:
                src = tag.get("source") or {}
                if src.get("protocol") != "modbus" or src.get("device") != device:
                    continue
                if src["address"].startswith("coil:"):
                    coils[tag["name"]] = int(src["address"].split(":", 1)[1])
                else:
                    regs[tag["name"]] = (int(src["address"]), float(src.get("scale", 1.0)))
            devices[device] = ModbusDevice(device, _port_of(endpoint), regs, coils)
    return devices


def _opcua_assets() -> list[dict]:
    """Assets the BMS gateway serves, in the shape plant_sim/ahu1.json uses."""
    chiller = _load(FIXTURES / "context.chiller.json")
    chiller_tags = [
        {"name": t["name"], "type": t["type"], "unit": t.get("unit"), "description": t.get("description", ""),
         "low": (t.get("range") or {}).get("low"), "high": (t.get("range") or {}).get("high")}
        for t in chiller["tags"]
        if (t.get("source") or {}).get("protocol") == "opcua"
    ]
    # The vibration sensor exists on the real machine before ScreenForge's
    # context knows about it -- that is the machine-change demo.
    chiller_tags.append({"name": "Vibration_PV", "type": "analog", "unit": "mm/s",
                         "description": "Compressor bearing vibration (RMS)", "low": 0, "high": 20})
    return [
        {"asset_id": chiller["asset_id"], "folder": "Chiller1", "asset_hierarchy": chiller["asset_hierarchy"],
         "aliases": chiller.get("aliases", []), "device": "BMS_Gateway", "tags": chiller_tags, "alarms": []},
        _load(HERE / "ahu1.json"),
    ]


async def _build_opcua(server: Server, assets: list[dict]) -> dict[str, object]:
    idx = await server.register_namespace("urn:screenforge:plant")
    plant = await server.nodes.objects.add_folder(ua.NodeId("Plant", idx), "Plant")
    nodes = {}
    for asset in assets:
        folder = asset["folder"]
        obj = await plant.add_object(ua.NodeId(folder, idx), folder)
        await obj.add_property(ua.NodeId(f"{folder}.AssetId", idx), "AssetId", asset["asset_id"])
        await obj.add_property(ua.NodeId(f"{folder}.AssetHierarchy", idx), "AssetHierarchy",
                               asset["asset_hierarchy"], ua.VariantType.String)
        await obj.add_property(ua.NodeId(f"{folder}.Aliases", idx), "Aliases",
                               asset.get("aliases", []) or [""], ua.VariantType.String)
        await obj.add_property(ua.NodeId(f"{folder}.Device", idx), "Device", asset["device"])
        for tag in asset["tags"]:
            node_id = f"{folder}.{tag['name']}"
            if tag["type"] == "bool":
                var = await obj.add_variable(ua.NodeId(node_id, idx), tag["name"], True, ua.VariantType.Boolean)
            else:
                var = await obj.add_variable(ua.NodeId(node_id, idx), tag["name"], 0.0, ua.VariantType.Double)
                if tag.get("unit"):
                    eu = ua.EUInformation(NamespaceUri="http://www.opcfoundation.org/UA/units/un/cefact",
                                          UnitId=-1, DisplayName=ua.LocalizedText(tag["unit"]),
                                          Description=ua.LocalizedText(tag["unit"]))
                    await var.add_property(ua.NodeId(f"{node_id}.EngineeringUnits", idx), "EngineeringUnits", eu)
                if tag.get("low") is not None and tag.get("high") is not None:
                    await var.add_property(ua.NodeId(f"{node_id}.EURange", idx), "EURange",
                                           ua.Range(Low=float(tag["low"]), High=float(tag["high"])))
            await var.add_property(ua.NodeId(f"{node_id}.Description", idx), "Description", tag.get("description", ""))
            nodes[tag["name"]] = var
        if asset.get("alarms"):
            alarms_folder = await obj.add_folder(ua.NodeId(f"{folder}.Alarms", idx), "Alarms")
            for alarm in asset["alarms"]:
                a_id = f"{folder}.Alarms.{alarm['id']}"
                a_obj = await alarms_folder.add_object(ua.NodeId(a_id, idx), alarm["id"])
                await a_obj.add_property(ua.NodeId(f"{a_id}.Desc", idx), "Desc", alarm["desc"])
                await a_obj.add_property(ua.NodeId(f"{a_id}.Priority", idx), "Priority", alarm["priority"])
                await a_obj.add_property(ua.NodeId(f"{a_id}.Tag", idx), "Tag", alarm["tag"])
                await a_obj.add_property(ua.NodeId(f"{a_id}.Op", idx), "Op", alarm["op"])
                limit_type = ua.VariantType.Boolean if isinstance(alarm["value"], bool) else ua.VariantType.Double
                await a_obj.add_property(ua.NodeId(f"{a_id}.Limit", idx), "Limit", alarm["value"], limit_type)
                await a_obj.add_property(ua.NodeId(f"{a_id}.Related", idx), "Related",
                                         alarm.get("related") or [""], ua.VariantType.String)
    return nodes


class Plant:
    def __init__(self):
        self.modbus = _modbus_devices()
        self.opcua_assets = _opcua_assets()
        signals: dict[str, str] = {}
        for path in sorted(FIXTURES.glob("context.*.json")):
            for tag in _load(path)["tags"]:
                src = tag.get("source") or {}
                if src.get("protocol") in ("opcua", "modbus"):
                    signals[tag["name"]] = tag["type"]
        for asset in self.opcua_assets:
            for tag in asset["tags"]:
                signals[tag["name"]] = tag["type"]
        self.model = PlantModel(signals)
        self.opcua_nodes: dict[str, object] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        server = Server()
        await server.init()
        server.set_endpoint(f"opc.tcp://{BIND}:{OPCUA_PORT}/screenforge")
        server.set_server_name("ScreenForge Simulated Plant")
        self.opcua_nodes = await _build_opcua(server, self.opcua_assets)
        for device in self.modbus.values():
            await device.start()
        _start_control_server(self)
        async with server:
            log.info("plant up: OPC UA :%d, Modbus %s, control :%d", OPCUA_PORT,
                     ", ".join(f"{d.name}:{d.port}" for d in self.modbus.values()), CONTROL_PORT)
            while True:
                values = self.model.step()
                for device in self.modbus.values():
                    await device.write(values)
                for name, node in self.opcua_nodes.items():
                    value = values.get(name)
                    if value is None:
                        continue
                    vtype = ua.VariantType.Boolean if isinstance(value, bool) else ua.VariantType.Double
                    await node.write_value(ua.DataValue(ua.Variant(value, vtype)))
                await asyncio.sleep(TICK_SECONDS)

    # -- control (called from the HTTP thread) --

    def status(self) -> dict:
        return {
            "values": dict(self.model.values),
            "faults": {k: {"value": v, "until": t} for k, (v, t) in self.model.faults.items()},
            "links": {name: d.up for name, d in self.modbus.items()},
            "modbus_writes_refused": {name: d.writes_refused for name, d in self.modbus.items()},
        }

    def set_link(self, device: str, up: bool) -> None:
        dev = self.modbus[device]
        coro = dev.start() if up else dev.stop()
        asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=5)  # type: ignore[arg-type]

    def reset(self) -> None:
        self.model.clear_faults()
        for name in self.modbus:
            self.set_link(name, True)


def _start_control_server(plant: Plant) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # noqa: N802
            self._send(204, {})

        def do_GET(self):  # noqa: N802
            self._send(200, plant.status())

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/fault":
                    plant.model.inject_fault(body["tag"], body["value"], float(body.get("seconds", 20)))
                elif self.path == "/link":
                    plant.set_link(body["device"], bool(body["up"]))
                elif self.path == "/reset":
                    plant.reset()
                else:
                    return self._send(404, {"error": f"unknown path {self.path}"})
            except KeyError as e:
                return self._send(400, {"error": f"unknown or missing {e}"})
            except Exception as e:  # demo control: report, don't crash the plant
                return self._send(400, {"error": str(e)})
            self._send(200, plant.status())

        def log_message(self, *_args):
            pass

    httpd = ThreadingHTTPServer((BIND, CONTROL_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("asyncua").setLevel(logging.WARNING)
    logging.getLogger("pymodbus").setLevel(logging.WARNING)
    asyncio.run(Plant().run())


if __name__ == "__main__":
    main()
