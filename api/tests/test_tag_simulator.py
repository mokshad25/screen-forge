"""
Proof that the tag simulator stays physically plausible.

Run:
    cd api && venv/bin/pytest tests/test_tag_simulator.py -q

This exists because of a bug that only appeared over many steps: an
excursion_swing of -40 was multiplied by a random +/- sign, so refrigerant
level climbed to 136% instead of falling. A single call looks fine; you have
to run the simulation for a while to see it. So these tests step it hard.
"""

import json
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = API_DIR.parent

if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import tag_simulator  # noqa: E402

ASSETS = ["line1.conveyorA", "plant.utilities.chiller1"]
STEPS = 3000


def _units() -> dict[str, str | None]:
    units = {}
    for path in (REPO_ROOT / "contracts" / "fixtures").glob("context.*.json"):
        for tag in json.loads(path.read_text())["tags"]:
            units[tag["name"]] = tag.get("unit")
    return units


@pytest.fixture(scope="module")
def observed() -> dict[str, list[float]]:
    """Min and max seen for every analog tag across a long run."""
    seen: dict[str, list[float]] = {}
    for _ in range(STEPS):
        for asset_id in ASSETS:
            for name, value in tag_simulator.get_live_values(asset_id)["tags"].items():
                if isinstance(value, bool):
                    continue
                if name not in seen:
                    seen[name] = [value, value]
                seen[name][0] = min(seen[name][0], value)
                seen[name][1] = max(seen[name][1], value)
    return seen


def test_percentage_tags_stay_within_0_to_100(observed):
    units = _units()
    checked = [n for n, u in units.items() if u == "%" and n in observed]
    assert checked, "no percentage tags found -- this test would prove nothing"
    for name in checked:
        low, high = observed[name]
        assert 0.0 <= low, f"{name} fell to {low}, below 0%"
        assert high <= 100.0, f"{name} reached {high}, above 100%"


def test_pressure_and_speed_never_go_negative(observed):
    units = _units()
    for name, unit in units.items():
        if unit in ("bar", "m/s") and name in observed:
            assert observed[name][0] >= 0.0, f"{name} went negative ({observed[name][0]})"


def test_temperature_may_go_negative(observed):
    """degC is deliberately unclamped -- chilled water really does."""
    units = _units()
    assert any(u == "degC" for u in units.values())


def test_negative_excursion_only_ever_falls(monkeypatch):
    """
    The actual bug, pinned directly rather than statistically: force the
    excursion branch and hand it the sign that used to send the value UP.

    The old code did `random.choice([-1, 1]) * excursion_swing`, so a swing
    of -40 with choice()==+1 became +40 and refrigerant climbed past 100%.
    """
    monkeypatch.setattr(tag_simulator.random, "random", lambda: 0.0)  # always excurse
    monkeypatch.setattr(tag_simulator.random, "choice", lambda seq: 1)  # the bad sign
    monkeypatch.setattr(tag_simulator.random, "uniform", lambda a, b: 0.0)

    baseline = tag_simulator._BASELINES["Refrigerant_Level_PV"]["baseline"]
    after = tag_simulator._step_analog(baseline, "Refrigerant_Level_PV", "%")
    assert after < baseline, (
        f"a negative excursion_swing moved the value up ({baseline} -> {after})"
    )


def test_positive_excursion_can_still_go_either_way(monkeypatch):
    """Positive swings keep their original two-way behaviour."""
    monkeypatch.setattr(tag_simulator.random, "random", lambda: 0.0)
    monkeypatch.setattr(tag_simulator.random, "uniform", lambda a, b: 0.0)
    baseline = tag_simulator._BASELINES["Temperature_PV"]["baseline"]

    monkeypatch.setattr(tag_simulator.random, "choice", lambda seq: 1)
    assert tag_simulator._step_analog(baseline, "Temperature_PV", "degC") > baseline

    monkeypatch.setattr(tag_simulator.random, "choice", lambda seq: -1)
    assert tag_simulator._step_analog(baseline, "Temperature_PV", "degC") < baseline


def test_clamp_holds_a_percentage_inside_range():
    assert tag_simulator._clamp_to_unit(136.0, "%") == 100.0
    assert tag_simulator._clamp_to_unit(-5.0, "%") == 0.0
    assert tag_simulator._clamp_to_unit(-1.2, "bar") == 0.0
    # degC is unclamped on purpose.
    assert tag_simulator._clamp_to_unit(-5.64, "degC") == -5.64
    # An unknown unit must not be clamped into nonsense.
    assert tag_simulator._clamp_to_unit(1234.0, "mm/s") == 1234.0
    assert tag_simulator._clamp_to_unit(1234.0, None) == 1234.0


def test_low_refrigerant_alarm_recovers():
    """
    ALM_LR01 should fire sometimes and clear again. An alarm that is always
    on carries no information on the screen.
    """
    active = 0
    runs = 4000
    for _ in range(runs):
        active += tag_simulator.get_live_values("plant.utilities.chiller1")["alarms"]["ALM_LR01"]
    share = active / runs
    assert 0.0 < share < 0.5, (
        f"ALM_LR01 active {share:.0%} of the time; it should fire "
        "occasionally and recover, not sit on or never trip"
    )
