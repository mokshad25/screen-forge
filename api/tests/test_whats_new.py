"""
Proof that a regenerated screen is told what changed on the machine.

Run:
    cd api && venv/bin/pytest tests/test_whats_new.py -q

No network: the whole pipeline takes an injectable llm_fn, so these assert on
the prompt the model WOULD receive, and on a stubbed generation.

Why this exists: after a context bump the model already sees the new tag --
it's in the context it's handed -- but "chiller overview" describes the same
screen whether or not a vibration sensor was fitted this morning, so it had
no reason to include it. The fix is salience, not retrieval.
"""

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parent.parent

if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import context_store  # noqa: E402
import generator  # noqa: E402
import reconciler  # noqa: E402

CHILLER = "plant.utilities.chiller1"


@pytest.fixture(autouse=True)
def _restore_context():
    yield
    context_store.reset_context(CHILLER)


def _capture_prompt():
    """An llm_fn that records the user prompt and returns a valid spec."""
    seen = {}

    def fake_llm(system_prompt, user_prompt):
        seen["user"] = user_prompt
        seen["system"] = system_prompt
        return {
            "screen_id": "gen_test", "title": "Chiller 1", "asset_id": CHILLER,
            "context_version": context_store.get_context(CHILLER)["context_version"],
            "components": [{
                "id": "c1", "type": "status_indicator", "priority": 1,
                "size_hint": "compact", "min_panel": "small",
                "bind_tag": "Compressor_RunStatus", "bind_alarms": None,
                "bind_device": None, "bind_asset": None,
            }],
            "permissions": {"mode": "read_only"},
        }

    return fake_llm, seen


def test_added_tag_is_named_when_regenerating_a_stale_screen():
    reconciler.bump_context(CHILLER)
    fake_llm, seen = _capture_prompt()

    generator.generate_and_validate(
        "chiller overview", CHILLER, "large",
        llm_fn=fake_llm, since_context_version="chiller1@v1",
    )

    assert "Vibration_PV" in seen["user"]
    assert "chiller1@v1 -> chiller1@v2" in seen["user"]
    assert "Newly available" in seen["user"]


def test_the_operators_words_are_never_rewritten():
    """
    The change is added as separate context. The request itself has to reach
    the model exactly as typed -- a judge's own phrasing is the demo.
    """
    reconciler.bump_context(CHILLER)
    fake_llm, seen = _capture_prompt()

    generator.generate_and_validate(
        "chiller overview", CHILLER, "large",
        llm_fn=fake_llm, since_context_version="chiller1@v1",
    )

    assert 'Operator request: "chiller overview"' in seen["user"]


def test_nothing_is_added_when_the_screen_is_already_current():
    fake_llm, seen = _capture_prompt()
    generator.generate_and_validate(
        "chiller overview", CHILLER, "large",
        llm_fn=fake_llm, since_context_version="chiller1@v1",
    )
    assert "Newly available" not in seen["user"]


def test_omitting_the_field_behaves_exactly_as_before():
    """The field is additive: /web can adopt it whenever it likes."""
    reconciler.bump_context(CHILLER)
    fake_llm, seen = _capture_prompt()

    generator.generate_and_validate("chiller overview", CHILLER, "large", llm_fn=fake_llm)

    assert "Newly available" not in seen["user"]
    assert "This machine changed" not in seen["user"]


def test_an_unknown_previous_version_is_ignored_rather_than_guessed():
    reconciler.bump_context(CHILLER)
    fake_llm, seen = _capture_prompt()

    generator.generate_and_validate(
        "chiller overview", CHILLER, "large",
        llm_fn=fake_llm, since_context_version="chiller1@v99",
    )

    assert "This machine changed" not in seen["user"]


def test_removed_tags_are_called_out_as_unbindable():
    context = context_store.get_context(CHILLER)
    context_store.reload_context(CHILLER, {
        **context,
        "context_version": "chiller1@v5",
        "tags": [t for t in context["tags"] if t["name"] != "Condenser_Pressure"],
    })
    fake_llm, seen = _capture_prompt()

    generator.generate_and_validate(
        "chiller overview", CHILLER, "large",
        llm_fn=fake_llm, since_context_version="chiller1@v1",
    )

    assert "No longer available" in seen["user"]
    assert "Condenser_Pressure" in seen["user"].split("No longer available")[1]
