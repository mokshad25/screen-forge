"""v2 validator rules: tag type must suit the component; multi_trend shares a unit."""

import validator

CHILLER = "plant.utilities.chiller1"


def _spec(*components):
    return {
        "screen_id": "t", "title": "t", "asset_id": CHILLER, "context_version": "chiller1@v1",
        "components": [{"id": f"c{i}", "priority": i, "size_hint": "medium", **c} for i, c in enumerate(components, 1)],
        "permissions": {"mode": "read_only"},
    }


def test_gauge_on_a_bool_is_rejected():
    r = validator.validate_spec(_spec({"type": "gauge", "bind_tag": "Compressor_RunStatus"}))
    assert not r.valid and r.failed_layer == "whitelist"
    assert "gauge needs an analog tag, but 'Compressor_RunStatus' is bool" in r.errors[0]


def test_status_light_on_an_analog_is_rejected():
    r = validator.validate_spec(_spec({"type": "status_indicator", "bind_tag": "Condenser_Pressure"}))
    assert not r.valid and "bool" in r.errors[0]


def test_numeric_readout_on_an_analog_is_fine():
    assert validator.validate_spec(_spec({"type": "numeric_readout", "bind_tag": "Condenser_Pressure"})).valid


def test_multi_trend_with_one_unit_is_fine():
    spec = _spec({"type": "multi_trend", "bind_tags": ["Condenser_Pressure", "Evaporator_Pressure"]})
    assert validator.validate_spec(spec).valid


def test_multi_trend_mixing_units_is_rejected():
    spec = _spec({"type": "multi_trend", "bind_tags": ["Condenser_Pressure", "Chilled_Water_Supply_Temp"]})
    r = validator.validate_spec(spec)
    assert not r.valid and "mixes units" in r.errors[0]


def test_multi_trend_needs_at_least_two_tags():
    r = validator.validate_spec(_spec({"type": "multi_trend", "bind_tags": ["Condenser_Pressure"]}))
    assert not r.valid and r.failed_layer == "schema"


def test_multi_trend_with_an_unknown_tag_is_rejected():
    spec = _spec({"type": "multi_trend", "bind_tags": ["Condenser_Pressure", "Made_Up_Pressure"]})
    r = validator.validate_spec(spec)
    assert not r.valid and "Made_Up_Pressure" in r.errors[0]


def test_layout_fields_are_still_impossible():
    spec = _spec({"type": "gauge", "bind_tag": "Condenser_Pressure", "width": 300})
    r = validator.validate_spec(spec)
    assert not r.valid and r.failed_layer == "schema"


def test_origin_is_allowed_but_closed():
    spec = _spec({"type": "gauge", "bind_tag": "Condenser_Pressure"})
    assert validator.validate_spec({**spec, "origin": {"kind": "edit", "instruction": "bigger"}}).valid
    assert not validator.validate_spec({**spec, "origin": {"kind": "edit", "colour": "red"}}).valid
