"""
Proof that api/validator.py works.

Two ways to run this:

    # 1. plain python -- prints one clean PASS/FAIL line per fixture, nothing
    #    else. This is the one to screenshot for the teammate.
    python api/tests/test_validator.py

    # 2. pytest -- same assertions as real tests; add -s to also see the
    #    summary block.
    cd api && venv/bin/pytest tests/test_validator.py -s

What it checks:
  * The 3 frozen golden specs in contracts/fixtures/ all validate=True.
  * valid_nav_tile.json (api/tests/fixtures/) also validates=True -- a
    nav_tile binding a known asset_id via bind_asset.
  * The 5 deliberately-broken specs in api/tests/fixtures/ all validate=False,
    each failing the exact layer it was built to break.

Note on broken_readonly.json: it sets permissions.mode = "read_write". The
frozen contract schema pins mode to the enum ["read_only"], so this spec is
rejected at LAYER 1 ("schema") -- it never reaches the layer-3 read-only
gate. The layer-3 mode check still exists in validator.py as independent
defense, it just isn't reachable while the schema enum stands.
"""

import json
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = API_DIR.parent

# Let this file find api/validator.py whether it's run via pytest or directly.
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from validator import validate_spec  # noqa: E402

CONTRACT_FIXTURES = REPO_ROOT / "contracts" / "fixtures"
BROKEN_FIXTURES = Path(__file__).resolve().parent / "fixtures"

# Golden specs that must pass all three layers.
GOLDEN_FILES = [
    "spec.golden.status-alarms.json",
    "spec.golden.trend.json",
    "spec.golden.comms.json",
]

# Non-golden specs (in api/tests/fixtures/, not the frozen contracts/) that
# must still pass all three layers.
EXTRA_PASSING_FILES = [
    "valid_nav_tile.json",
]

# Broken specs: (filename, expected failed_layer, why it's broken).
BROKEN_CASES = [
    (
        "broken_schema.json",
        "schema",
        "omits the required 'permissions' block",
    ),
    (
        "broken_whitelist_tag.json",
        "whitelist",
        "bind_tag 'Motr_Speed' is not a tag in line1.conveyorA's context",
    ),
    (
        "broken_whitelist_alarm.json",
        "whitelist",
        "bind_alarms id 'ALM_NOPE99' is not an alarm in line1.conveyorA's context",
    ),
    (
        "broken_readonly.json",
        "schema",
        "permissions.mode 'read_write' is rejected by the frozen schema enum "
        "at layer 1, before the layer-3 read-only gate is reached",
    ),
    (
        "broken_duplicate_id.json",
        "whitelist",
        "two components share the id 'c1'",
    ),
    (
        "broken_write_tag.json",
        "whitelist",
        "gauge binds 'Motor_Start', which is an access: write command tag",
    ),
    (
        "broken_nav_tile_unknown_asset.json",
        "whitelist",
        "nav_tile bind_asset 'plant.utilities.boilerZZ' is not a known asset_id",
    ),
]


def _load(path: Path) -> dict:
    with open(path, "r") as f:
        return json.load(f)


# --------------------------------------------------------------------------
# pytest tests
# --------------------------------------------------------------------------
@pytest.mark.parametrize("filename", GOLDEN_FILES)
def test_golden_specs_pass_all_layers(filename):
    result = validate_spec(_load(CONTRACT_FIXTURES / filename))
    assert result.valid is True, (
        f"{filename}: expected valid, got failed_layer={result.failed_layer!r} "
        f"errors={result.errors}"
    )
    assert result.failed_layer is None
    assert result.errors == []


@pytest.mark.parametrize("filename", EXTRA_PASSING_FILES)
def test_extra_passing_specs_pass_all_layers(filename):
    result = validate_spec(_load(BROKEN_FIXTURES / filename))
    assert result.valid is True, (
        f"{filename}: expected valid, got failed_layer={result.failed_layer!r} "
        f"errors={result.errors}"
    )
    assert result.failed_layer is None
    assert result.errors == []


@pytest.mark.parametrize(
    "filename,expected_layer",
    [(name, layer) for (name, layer, _why) in BROKEN_CASES],
)
def test_broken_specs_fail_their_layer(filename, expected_layer):
    result = validate_spec(_load(BROKEN_FIXTURES / filename))
    assert result.valid is False, f"{filename}: expected rejection, got valid=True"
    assert result.failed_layer == expected_layer, (
        f"{filename}: expected failed_layer={expected_layer!r}, "
        f"got {result.failed_layer!r} -- errors={result.errors}"
    )
    assert result.errors, f"{filename}: rejected but gave no error messages"


# --------------------------------------------------------------------------
# Human-readable summary (screenshot this)
# --------------------------------------------------------------------------
def run_summary() -> bool:
    """Print one line per fixture. Return True iff every fixture behaved."""
    lines: list[str] = []
    ok = True

    for filename in GOLDEN_FILES:
        result = validate_spec(_load(CONTRACT_FIXTURES / filename))
        if result.valid:
            lines.append(f"{filename}: PASS (valid)")
        else:
            ok = False
            lines.append(
                f"{filename}: FAIL (expected valid, rejected at layer "
                f"'{result.failed_layer}': {result.errors})"
            )

    for filename in EXTRA_PASSING_FILES:
        result = validate_spec(_load(BROKEN_FIXTURES / filename))
        if result.valid:
            lines.append(f"{filename}: PASS (valid)")
        else:
            ok = False
            lines.append(
                f"{filename}: FAIL (expected valid, rejected at layer "
                f"'{result.failed_layer}': {result.errors})"
            )

    for filename, expected_layer, _why in BROKEN_CASES:
        result = validate_spec(_load(BROKEN_FIXTURES / filename))
        if not result.valid and result.failed_layer == expected_layer:
            lines.append(
                f"{filename}: PASS (correctly rejected at layer '{expected_layer}')"
            )
        elif result.valid:
            ok = False
            lines.append(
                f"{filename}: FAIL (expected rejection at layer "
                f"'{expected_layer}', but spec was accepted)"
            )
        else:
            ok = False
            lines.append(
                f"{filename}: FAIL (expected rejection at layer "
                f"'{expected_layer}', got layer '{result.failed_layer}')"
            )

    print("\nScreenForge validator -- fixture check")
    print("-" * 54)
    for line in lines:
        print(line)
    print("-" * 54)
    print("ALL FIXTURES BEHAVED AS EXPECTED" if ok else "SOME FIXTURES MISBEHAVED")
    return ok


@pytest.fixture(scope="session", autouse=True)
def _summary_after_tests():
    yield
    run_summary()


if __name__ == "__main__":
    sys.exit(0 if run_summary() else 1)
