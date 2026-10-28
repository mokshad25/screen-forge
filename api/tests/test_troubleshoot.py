"""Alarm-triggered troubleshooting screens: deterministic, validated, useful."""

import pytest

import alarms
import context_store
import troubleshoot
import validator

ALL_ALARMS = [(ctx["asset_id"], a["id"]) for ctx in context_store.all_contexts() for a in ctx["alarms"]]


def setup_function():
    alarms.reset()


@pytest.mark.parametrize("asset_id,alarm_id", ALL_ALARMS)
def test_every_alarm_gets_a_valid_screen(asset_id, alarm_id):
    spec = troubleshoot.build_alarm_screen(context_store.get_context(asset_id), alarm_id)
    assert validator.validate_spec(spec).valid
    assert spec["origin"] == {"kind": "alarm", "alarm_id": alarm_id}
    first = spec["components"][0]
    assert first["type"] == "alarm_banner" and first["bind_alarms"][0] == alarm_id and first["priority"] == 1


@pytest.mark.parametrize("asset_id,alarm_id", ALL_ALARMS)
def test_the_seven_inch_panel_shows_the_alarm_and_its_signal(asset_id, alarm_id):
    ctx = context_store.get_context(asset_id)
    alarm = next(a for a in ctx["alarms"] if a["id"] == alarm_id)
    spec = troubleshoot.build_alarm_screen(ctx, alarm_id)
    small = [c for c in spec["components"] if c["priority"] <= 3 and c.get("min_panel", "small") == "small"]
    assert any(c.get("bind_tag") == alarm["tag"] for c in small)


def test_same_alarm_same_screen():
    ctx = context_store.get_context("plant.utilities.chiller1")
    a = troubleshoot.build_alarm_screen(ctx, "ALM_HP01", now=1)
    b = troubleshoot.build_alarm_screen(ctx, "ALM_HP01", now=2)
    assert a["components"] == b["components"]


def test_the_playbook_is_used_when_the_context_has_one():
    ctx = context_store.get_context("plant.utilities.chiller1")
    spec = troubleshoot.build_alarm_screen(ctx, "ALM_HP01")
    bound = {c.get("bind_tag") for c in spec["components"]}
    assert {"Evaporator_Pressure", "Compressor_RunStatus", "Chilled_Water_Return_Temp"} <= bound


def test_same_unit_signals_are_compared_on_one_chart():
    ctx = context_store.get_context("plant.utilities.chiller1")
    spec = troubleshoot.build_alarm_screen(ctx, "ALM_HP01")
    multi = [c for c in spec["components"] if c["type"] == "multi_trend"]
    assert multi and multi[0]["bind_tags"] == ["Condenser_Pressure", "Evaporator_Pressure"]


def test_the_comms_link_the_signal_arrives_over_is_shown():
    ctx = context_store.get_context("plant.utilities.chiller1")
    spec = troubleshoot.build_alarm_screen(ctx, "ALM_CT01")  # compressor status comes from the VFD
    assert {"type": "comms_health", "bind_device": "Compressor_VFD"} in [
        {k: c[k] for k in ("type", "bind_device") if k in c} for c in spec["components"]
    ]


def test_without_a_playbook_related_signals_are_guessed_by_equipment_and_unit():
    ctx = context_store.get_context("plant.utilities.chiller1")
    alarm = {"id": "X", "tag": "Condenser_Pressure", "related_tags": []}
    related = troubleshoot.related_tags(ctx, alarm)
    assert related[0] == "Evaporator_Pressure"  # same unit
    assert "BMS_Comm_Health" not in related


def test_other_active_alarms_join_the_banner():
    ctx = context_store.get_context("plant.utilities.chiller1")
    alarms.update(ctx, {"Condenser_Pressure": 9, "Refrigerant_Level_PV": 40, "Compressor_RunStatus": True})
    spec = troubleshoot.build_alarm_screen(ctx, "ALM_HP01")
    assert spec["components"][0]["bind_alarms"] == ["ALM_HP01", "ALM_LR01"]


def test_unknown_alarm_is_refused():
    with pytest.raises(KeyError):
        troubleshoot.build_alarm_screen(context_store.get_context("line1.conveyorA"), "ALM_NOPE")
