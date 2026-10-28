"""
Proof that the reconciler reports machine changes honestly.

Run:
    cd api && venv/bin/pytest tests/test_reconciler.py -q

Every test resets the context afterwards, because a bump mutates state shared
by the whole process -- the same reason the demo needs a reset endpoint.
"""

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parent.parent

if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import context_store  # noqa: E402
import reconciler  # noqa: E402
import tag_simulator  # noqa: E402

CHILLER = "plant.utilities.chiller1"


@pytest.fixture(autouse=True)
def _restore_context():
    yield
    context_store.reset_context(CHILLER)


def _spec(context_version="chiller1@v1", bind_tag="Compressor_RunStatus"):
    return {
        "screen_id": "s1",
        "title": "Chiller 1",
        "asset_id": CHILLER,
        "context_version": context_version,
        "components": [{
            "id": "c1", "type": "status_indicator", "bind_tag": bind_tag,
            "priority": 1, "size_hint": "compact",
        }],
        "permissions": {"mode": "read_only"},
    }


def test_a_current_screen_is_not_stale():
    report = reconciler.reconcile(_spec())
    assert report["stale"] is False
    assert report["broken_bindings"] == []
    assert report["still_valid"] is True


def test_bump_adds_the_sensor_and_moves_the_version_on():
    before = context_store.get_context(CHILLER)["context_version"]
    result = reconciler.bump_context(CHILLER)

    assert result["changed"] is True
    assert result["context_version"] != before
    assert result["changes"]["tags_added"] == ["Vibration_PV"]
    assert result["changes"]["tags_removed"] == []
    assert any(t["name"] == "Vibration_PV" for t in result["context"]["tags"])


def test_bump_twice_is_refused_rather_than_silently_doing_nothing():
    reconciler.bump_context(CHILLER)
    second = reconciler.bump_context(CHILLER)

    assert second["changed"] is False
    assert "reset" in second["reason"]


def test_reset_restores_the_version_on_disk():
    original = context_store.get_context(CHILLER)["context_version"]
    reconciler.bump_context(CHILLER)
    restored = context_store.reset_context(CHILLER)

    assert restored["context_version"] == original
    assert not any(t["name"] == "Vibration_PV" for t in restored["tags"])


def test_an_added_sensor_makes_a_screen_stale_but_not_broken():
    """The ordinary case: nothing the screen binds has gone away."""
    reconciler.bump_context(CHILLER)
    report = reconciler.reconcile(_spec("chiller1@v1"))

    assert report["stale"] is True
    assert report["spec_context_version"] == "chiller1@v1"
    assert report["current_context_version"] == "chiller1@v2"
    assert report["changes"]["tags_added"] == ["Vibration_PV"]
    assert report["broken_bindings"] == []
    assert report["still_valid"] is True


def test_a_binding_that_no_longer_exists_is_named_precisely():
    report = reconciler.reconcile(_spec(bind_tag="Deleted_Tag"))

    assert report["still_valid"] is False
    assert len(report["broken_bindings"]) == 1
    broken = report["broken_bindings"][0]
    assert broken["component_id"] == "c1"
    assert broken["field"] == "bind_tag"
    assert broken["value"] == "Deleted_Tag"


def test_a_screen_built_against_an_unknown_version_still_reports():
    """We can't diff a version we never held, but staleness still answers."""
    report = reconciler.reconcile(_spec("chiller1@v99"))

    assert report["stale"] is True
    assert report["changes"] is None
    assert report["still_valid"] is True


def test_reconcile_never_modifies_the_spec():
    spec = _spec()
    before = dict(spec)
    reconciler.reconcile(spec)
    assert spec == before


def test_tags_keeps_serving_across_a_bump():
    """
    Regression: /tags used to raise KeyError on the newly added tag when
    polling had already started before the bump -- which is the demo's
    running order, so this would have failed live.
    """
    tag_simulator.get_live_values(CHILLER)  # polling starts, state built at v1
    reconciler.bump_context(CHILLER)

    values = tag_simulator.get_live_values(CHILLER)
    assert "Vibration_PV" in values["tags"]
    assert values["context_version"] == "chiller1@v2"
    assert isinstance(values["tags"]["Vibration_PV"], float)


def test_a_removed_tag_disappears_from_tags():
    context = context_store.get_context(CHILLER)
    trimmed = {
        **context,
        "context_version": "chiller1@v9",
        "tags": [t for t in context["tags"] if t["name"] != "Condenser_Pressure"],
    }
    tag_simulator.get_live_values(CHILLER)
    context_store.reload_context(CHILLER, trimmed)

    values = tag_simulator.get_live_values(CHILLER)
    assert "Condenser_Pressure" not in values["tags"]
