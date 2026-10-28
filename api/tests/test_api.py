"""HTTP-level behaviour: streams, the screen library, alarms, faults, rate limiting."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

import acquisition
import alarms
import context_store
import generator
import main

CHILLER = "plant.utilities.chiller1"
GOOD = {
    "screen_id": "gen_t", "title": "Chiller", "asset_id": CHILLER, "context_version": "chiller1@v1",
    "components": [{"id": "c1", "type": "gauge", "bind_tag": "Condenser_Pressure", "priority": 1,
                    "size_hint": "medium", "min_panel": "small", "bind_tags": None, "bind_alarms": None,
                    "bind_device": None, "bind_asset": None}],
    "permissions": {"mode": "read_only"},
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(generator, "_call_llm", lambda system, user: json.loads(json.dumps(GOOD)))
    main._calls.clear()
    alarms.reset()
    with TestClient(main.app) as c:
        yield c
    context_store.reset_context(CHILLER)


def _sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_generate_stream_reports_each_stage_then_the_spec(client):
    r = client.post("/generate/stream", json={"prompt": "condenser pressure", "asset_id": None, "panel_class": "small"})
    events = _sse(r.text)
    stages = [(d["stage"], d["status"]) for kind, d in events if kind == "stage"]
    assert stages[0] == ("intent", "running") and ("read_only", "ok") in stages
    kind, result = events[-1]
    assert kind == "result" and result["spec"]["asset_id"] == CHILLER  # detected from "condenser"


def test_control_request_stream_ends_with_the_refusal(client):
    events = _sse(client.post("/generate/stream", json={"prompt": "drop the compressor speed a bit"}).text)
    assert events[-1][1]["error"]["stage"] == "read_only"


def test_edit_returns_a_diff(client):
    current = {**GOOD, "components": [{k: v for k, v in GOOD["components"][0].items() if v is not None}]}
    r = client.post("/edit", json={"instruction": "keep it", "spec": current}).json()
    assert r["diff"]["unchanged"] is True


def test_an_invalid_screen_is_never_saved(client):
    bad = {**GOOD, "components": [{"id": "c1", "type": "gauge", "bind_tag": "Ghost", "priority": 1, "size_hint": "medium"}]}
    assert client.post("/screens", json={"spec": bad}).json()["error"]["stage"] == "whitelist"
    assert client.get("/screens").json() == []


def test_save_list_load_delete_a_screen(client):
    spec = {**GOOD, "components": [{k: v for k, v in GOOD["components"][0].items() if v is not None}]}
    assert client.post("/screens", json={"spec": spec}).json()["screen"]["screen_id"] == "gen_t"
    assert [s["screen_id"] for s in client.get("/screens").json()] == ["gen_t"]
    loaded = client.get("/screens/gen_t").json()
    assert loaded["spec"] == spec and loaded["reconcile"]["still_valid"] is True
    assert client.delete("/screens/gen_t").json() == {"deleted": True}


def test_a_fault_raises_an_alarm_with_its_troubleshooting_screen(client):
    q = acquisition.hub.subscribe()
    assert client.post("/sim/fault", json={"asset_id": CHILLER, "tag": "Condenser_Pressure", "value": 13.0}).json() == {"injected": True}
    asyncio.run(acquisition.tick())
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    acquisition.hub.unsubscribe(q)
    raised = [e for e in events if e["type"] == "alarm" and e["alarm_id"] == "ALM_HP01"]
    assert raised and raised[0]["event"] == "raised"
    assert raised[0]["screen"]["origin"] == {"kind": "alarm", "alarm_id": "ALM_HP01"}
    log = client.get("/log", params={"kind": "alarm_raised"}).json()
    assert any(e["alarm_id"] == "ALM_HP01" for e in log)


def test_ack_is_local_and_logged(client):
    client.post("/sim/fault", json={"asset_id": CHILLER, "tag": "Condenser_Pressure", "value": 13.0})
    asyncio.run(acquisition.tick())
    assert client.post(f"/alarms/{CHILLER}/ALM_HP01/ack").json() == {"acked": True}
    assert client.get(f"/alarms/{CHILLER}").json()["ALM_HP01"]["acked"] is True
    assert client.get("/log", params={"kind": "alarm_acked"}).json()[0]["alarm_id"] == "ALM_HP01"


def test_fault_on_an_unknown_tag_is_refused(client):
    r = client.post("/sim/fault", json={"asset_id": CHILLER, "tag": "Ghost", "value": 1}).json()
    assert r["error"]["stage"] == "whitelist"


def test_llm_endpoints_are_rate_limited(client, monkeypatch):
    monkeypatch.setattr(main, "_LLM_LIMIT", 2)
    body = {"prompt": "condenser pressure", "asset_id": CHILLER}
    assert "spec" in client.post("/generate", json=body).json()
    assert "spec" in client.post("/generate", json=body).json()
    assert "Too many" in client.post("/generate", json=body).json()["error"]["message"]


def test_generation_is_audited(client):
    client.post("/generate", json={"prompt": "condenser pressure", "asset_id": CHILLER})
    entry = client.get("/log", params={"kind": "generate"}).json()[0]
    assert entry["request"] == "condenser pressure" and entry["ok"] is True


def test_health_never_leaks_the_key(client, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_secret_value")
    body = client.get("/health").text
    assert "gsk_secret_value" not in body and '"configured":true' in body


def test_tags_carry_quality_and_alarm_states(client):
    snap = client.get(f"/tags/{CHILLER}").json()
    assert set(snap["quality"].values()) == {"good"}
    assert set(snap["alarm_states"]) == {"ALM_HP01", "ALM_LR01", "ALM_CT01"}
