"""Alarm engine: conditions from the machine context, transitions, quality, acknowledgement."""

import alarms
import context_store

CHILLER = "plant.utilities.chiller1"


def setup_function():
    alarms.reset()


def _values(**overrides):
    base = {"Condenser_Pressure": 9.0, "Refrigerant_Level_PV": 85.0, "Compressor_RunStatus": True}
    return {**base, **overrides}


def test_conditions_come_from_the_context():
    ctx = context_store.get_context(CHILLER)
    states = alarms.evaluate_conditions(ctx, _values(Condenser_Pressure=11.5))
    assert states == {"ALM_HP01": True, "ALM_LR01": False, "ALM_CT01": False}


def test_a_bool_alarm_compares_as_bool():
    ctx = context_store.get_context(CHILLER)
    assert alarms.evaluate_conditions(ctx, _values(Compressor_RunStatus=False))["ALM_CT01"] is True


def test_no_reading_never_raises_an_alarm():
    assert alarms.condition_holds({"op": "<", "value": 60}, None) is False


def test_raise_then_clear_produces_two_transitions():
    ctx = context_store.get_context(CHILLER)
    raised = alarms.update(ctx, _values(Condenser_Pressure=12.0))
    assert [(t["alarm_id"], t["event"]) for t in raised] == [("ALM_HP01", "raised")]
    assert alarms.update(ctx, _values(Condenser_Pressure=12.1)) == []  # still active: no new event
    cleared = alarms.update(ctx, _values())
    assert [(t["alarm_id"], t["event"]) for t in cleared] == [("ALM_HP01", "cleared")]


def test_bad_quality_holds_the_alarm_instead_of_clearing_it():
    """A dropped link is not evidence the pressure came down (ISA-18.2 practice)."""
    ctx = context_store.get_context(CHILLER)
    alarms.update(ctx, _values(Condenser_Pressure=12.0))
    transitions = alarms.update(ctx, _values(Condenser_Pressure=None), quality={"Condenser_Pressure": "bad"})
    assert transitions == []
    snap = alarms.snapshot(ctx)["ALM_HP01"]
    assert snap["active"] is True and snap["quality"] == "bad"


def test_bad_quality_does_not_raise_a_trip_either():
    """Losing the VFD link must not read as a compressor trip."""
    ctx = context_store.get_context(CHILLER)
    alarms.update(ctx, _values())
    transitions = alarms.update(ctx, _values(Compressor_RunStatus=False), quality={"Compressor_RunStatus": "bad"})
    assert transitions == []


def test_acknowledge_only_applies_to_active_alarms():
    ctx = context_store.get_context(CHILLER)
    assert alarms.acknowledge(CHILLER, "ALM_HP01") is False
    alarms.update(ctx, _values(Condenser_Pressure=12.0))
    assert alarms.acknowledge(CHILLER, "ALM_HP01") is True
    assert alarms.snapshot(ctx)["ALM_HP01"]["acked"] is True


def test_reraising_clears_the_old_acknowledgement():
    ctx = context_store.get_context(CHILLER)
    alarms.update(ctx, _values(Condenser_Pressure=12.0))
    alarms.acknowledge(CHILLER, "ALM_HP01")
    alarms.update(ctx, _values())
    alarms.update(ctx, _values(Condenser_Pressure=12.0))
    assert alarms.snapshot(ctx)["ALM_HP01"]["acked"] is False


def test_active_ids_are_most_severe_first():
    ctx = context_store.get_context(CHILLER)
    alarms.update(ctx, _values(Refrigerant_Level_PV=40.0))
    alarms.update(ctx, _values(Refrigerant_Level_PV=40.0, Condenser_Pressure=12.0))
    assert alarms.active_ids(ctx) == ["ALM_HP01", "ALM_LR01"]
