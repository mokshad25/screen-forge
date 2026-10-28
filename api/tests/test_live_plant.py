"""
Integration: ScreenForge against the simulated plant over real OPC UA and
Modbus TCP. Starts plant_sim as a separate process; skipped if its ports are
already taken (e.g. a plant is running for a demo).
"""

import asyncio
import json
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

import acquisition
import alarms
import context_store
import opcua_import

ROOT = Path(__file__).resolve().parents[2]
PORTS = (4840, 5020, 5021, 8090)
ENDPOINT = "opc.tcp://127.0.0.1:4840/screenforge"
CHILLER = "plant.utilities.chiller1"


def _port_busy(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def _control(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:8090{path}", data=data, method="POST" if data else "GET")
    return json.load(urllib.request.urlopen(req, timeout=5))


@pytest.fixture(scope="module")
def plant():
    if any(_port_busy(p) for p in PORTS):
        pytest.skip("plant ports in use")
    proc = subprocess.Popen([sys.executable, "-m", "plant_sim"], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 20
    while time.time() < deadline and not all(_port_busy(p) for p in PORTS):
        time.sleep(0.3)
    if not all(_port_busy(p) for p in PORTS):
        proc.kill()
        pytest.fail("plant_sim did not come up")
    yield proc
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture
def live(monkeypatch, plant):
    monkeypatch.setenv("SCREENFORGE_TAG_SOURCE", "live")
    alarms.reset()
    acquisition._reader.__init__()
    _control("/reset", {})
    yield
    asyncio.run(acquisition._reader.close())
    acquisition._reader.__init__()


def _tick_until(predicate, seconds: float = 12):
    async def run():
        deadline = time.time() + seconds
        while time.time() < deadline:
            await acquisition.tick()
            if predicate():
                return True
            await asyncio.sleep(0.5)
        return False
    return asyncio.run(run())


def test_values_arrive_over_opcua_and_modbus_and_match_the_plant(live):
    assert _tick_until(lambda: acquisition._snapshots.get(CHILLER, {}).get("quality", {}).get("Condenser_Pressure") == "good")
    truth = _control("/")["values"]
    snap = acquisition._snapshots[CHILLER]
    assert abs(snap["tags"]["Condenser_Pressure"] - truth["Condenser_Pressure"]) < 1.0  # OPC UA
    conveyor = acquisition._snapshots["line1.conveyorA"]
    assert conveyor["quality"]["Temperature_PV"] == "good"  # Modbus holding register
    assert abs(conveyor["tags"]["Temperature_PV"] - truth["Temperature_PV"]) < 5.0
    assert snap["tags"]["BMS_Comm_Health"] is True and conveyor["tags"]["PLC1_Health"] is True


def test_a_pulled_link_marks_values_bad_and_reports_the_link_down(live):
    assert _tick_until(lambda: acquisition._snapshots.get(CHILLER, {}).get("tags", {}).get("VFD_Comm_Health") is True)
    _control("/link", {"device": "Compressor_VFD", "up": False})
    assert _tick_until(lambda: acquisition._snapshots[CHILLER]["tags"]["VFD_Comm_Health"] is False)
    snap = acquisition._snapshots[CHILLER]
    assert snap["quality"]["Compressor_RunStatus"] == "bad"
    assert snap["alarm_states"]["ALM_CT01"]["active"] is False  # a lost link is not a trip
    _control("/link", {"device": "Compressor_VFD", "up": True})
    assert _tick_until(lambda: acquisition._snapshots[CHILLER]["quality"]["Compressor_RunStatus"] == "good")


def test_a_plant_fault_raises_the_alarm_from_the_context_condition(live):
    _control("/fault", {"tag": "Condenser_Pressure", "value": 13.5, "seconds": 15})
    assert _tick_until(lambda: acquisition._snapshots[CHILLER]["alarm_states"]["ALM_HP01"]["active"])


def test_screenforge_never_sends_a_modbus_write(live):
    _tick_until(lambda: False, seconds=3)
    assert set(_control("/")["modbus_writes_refused"].values()) == {0}


def test_import_an_unknown_machine_from_opcua(live):
    listed = asyncio.run(opcua_import.list_assets(ENDPOINT))
    assert {"asset_id": "plant.utilities.ahu1", "known": False}.items() <= next(
        a for a in listed if a["asset_id"] == "plant.utilities.ahu1").items()
    result = asyncio.run(opcua_import.import_asset(ENDPOINT, "plant.utilities.ahu1"))
    ctx = result["context"]
    filter_dp = next(t for t in ctx["tags"] if t["name"] == "Filter_DP")
    assert filter_dp["unit"] == "Pa" and filter_dp["range"] == {"low": 0.0, "high": 500.0}
    assert {a["id"] for a in ctx["alarms"]} == {"ALM_FD01", "ALM_SA01", "ALM_FF01"}
    assert _tick_until(lambda: acquisition._snapshots.get("plant.utilities.ahu1", {}).get("quality", {}).get("Filter_DP") == "good")


def test_importing_a_fixture_machine_is_refused(live):
    with pytest.raises(opcua_import.ImportRefused, match="already configured"):
        asyncio.run(opcua_import.import_asset(ENDPOINT, CHILLER))
