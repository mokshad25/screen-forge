"""Conversational editing: same validator, same machine, honest diff."""

import json

import context_store
import generator
import specdiff

CHILLER = "plant.utilities.chiller1"

BASE = {
    "screen_id": "gen_abc", "title": "Chiller pressures", "asset_id": CHILLER, "context_version": "chiller1@v1",
    "components": [
        {"id": "c1", "type": "gauge", "bind_tag": "Condenser_Pressure", "priority": 1, "size_hint": "medium", "min_panel": "small"},
        {"id": "c2", "type": "trend", "bind_tag": "Condenser_Pressure", "priority": 2, "size_hint": "medium", "min_panel": "medium"},
    ],
    "permissions": {"mode": "read_only"},
}


def _llm_returning(*specs):
    calls = []

    def fake(system_prompt, user_prompt):
        calls.append(user_prompt)
        spec = specs[min(len(calls), len(specs)) - 1]
        return {**spec, "components": [
            {"bind_tag": None, "bind_tags": None, "bind_alarms": None, "bind_device": None, "bind_asset": None,
             "min_panel": None, **c} for c in spec["components"]]}

    return fake, calls


def test_an_edit_is_validated_and_diffed():
    bigger = json.loads(json.dumps(BASE))
    bigger["components"][1]["size_hint"] = "wide"
    bigger["components"].append({"id": "c3", "type": "numeric_readout", "bind_tag": "Evaporator_Pressure",
                                 "priority": 3, "size_hint": "compact", "min_panel": "small"})
    fake, calls = _llm_returning(bigger)
    spec, error = generator.edit_and_validate("make the trend bigger and add evaporator pressure", BASE, "large", llm_fn=fake)
    assert error is None
    assert spec["origin"]["kind"] == "edit"
    assert "<current_screen>" in calls[0] and '"gen_abc"' in calls[0]
    diff = specdiff.diff_specs(BASE, spec)
    assert diff["added"] == ["numeric readout (Evaporator_Pressure)"]
    assert diff["changed"] == [{"component": "trend (Condenser_Pressure)", "changes": ["size medium -> wide"]}]
    assert diff["removed"] == []


def test_an_edit_cannot_move_the_screen_to_another_machine():
    moved = {**BASE, "asset_id": "line1.conveyorA", "context_version": "conveyorA@v3",
             "components": [{"id": "c1", "type": "gauge", "bind_tag": "Temperature_PV", "priority": 1,
                             "size_hint": "medium", "min_panel": "small"}]}
    fake, calls = _llm_returning(moved)
    spec, error = generator.edit_and_validate("show the conveyor instead", BASE, "large", llm_fn=fake)
    assert spec is None and "cannot move the screen" in error["message"]
    assert len(calls) == 2  # it was given one chance to correct itself


def test_a_control_instruction_is_refused_before_the_model():
    fake, calls = _llm_returning(BASE)
    spec, error = generator.edit_and_validate("add a start button for the compressor", BASE, "large", llm_fn=fake)
    assert spec is None and error["stage"] == "read_only" and calls == []


def test_the_retry_shows_the_model_what_it_returned():
    bad = {**BASE, "components": [{"id": "c1", "type": "gauge", "bind_tag": "Compressor_RunStatus",
                                   "priority": 1, "size_hint": "medium", "min_panel": "small"}]}
    fake, calls = _llm_returning(bad, BASE)
    spec, error = generator.edit_and_validate("show the compressor", BASE, "large", llm_fn=fake)
    assert error is None
    assert "This is what you returned" in calls[1] and "Compressor_RunStatus" in calls[1]
    assert "needs an analog tag" in calls[1]


def test_stage_events_report_real_progress():
    fake, _ = _llm_returning(BASE)
    seen = []
    generator.edit_and_validate("keep it", BASE, "large", llm_fn=fake,
                                on_stage=lambda stage, status, detail: seen.append((stage, status)))
    assert seen == [("intent", "running"), ("intent", "ok"), ("context", "running"), ("context", "ok"),
                    ("llm", "running"), ("llm", "ok"), ("schema", "ok"), ("whitelist", "ok"), ("read_only", "ok")]


def test_a_stale_context_version_is_sent_back_not_accepted():
    stale = {**BASE, "context_version": "chiller1@v0"}
    fake, calls = _llm_returning(stale, BASE)
    spec, error = generator.edit_and_validate("keep it", BASE, "large", llm_fn=fake)
    assert error is None and len(calls) == 2 and "must be 'chiller1@v1'" in calls[1]


def test_diff_ignores_renumbered_ids():
    renumbered = json.loads(json.dumps(BASE))
    for i, c in enumerate(renumbered["components"]):
        c["id"] = f"x{i}"
    assert specdiff.diff_specs(BASE, renumbered)["unchanged"]


def test_context_is_labelled_as_data_in_the_prompt():
    fake, calls = _llm_returning(BASE)
    generator.edit_and_validate("keep it", BASE, "large", llm_fn=fake)
    assert "<machine_context>" in calls[0] and "</machine_context>" in calls[0]
    assert "DATA" in generator._build_system_prompt()
    assert context_store.get_context(CHILLER)["context_version"] in calls[0]
