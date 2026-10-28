"""
Demo step 6: feed the validator a malformed spec, watch it reject it readably.

    python api/demo_validate.py                 # every broken fixture, one per block
    python api/demo_validate.py path/to.json    # one spec of your choosing

Prints the layer that rejected each spec and the exact error text, which is
the part worth showing: the validator names the field that failed, it does
not just say "invalid". Nothing here repairs anything -- an invalid spec is
reported, never quietly fixed.

Wide left margin and blank lines on purpose: this gets read off a projector.
"""

import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parent
REPO_ROOT = API_DIR.parent
sys.path.insert(0, str(API_DIR))

import validator  # noqa: E402

BROKEN_DIR = API_DIR / "tests" / "fixtures"
GOLDEN = REPO_ROOT / "contracts" / "fixtures" / "spec.golden.status-alarms.json"

# Shown in this order: a valid spec first, so the contrast is visible.
DEMO_ORDER = [
    (GOLDEN, "a hand-written golden spec -- this one is correct"),
    (BROKEN_DIR / "broken_schema.json", "the 'permissions' block is missing"),
    (BROKEN_DIR / "broken_whitelist_tag.json", "binds a tag this machine does not have"),
    (BROKEN_DIR / "broken_whitelist_alarm.json", "binds an alarm id that does not exist"),
    (BROKEN_DIR / "broken_write_tag.json", "binds a write-access command tag"),
    (BROKEN_DIR / "broken_readonly.json", "asks for read_write permissions"),
    (BROKEN_DIR / "broken_duplicate_id.json", "two components share one id"),
]

LAYERS = {
    "schema": "LAYER 1  JSON Schema",
    "whitelist": "LAYER 2  tag/alarm whitelist",
    "read_only": "LAYER 3  read-only gate",
}


def check(path: Path, why: str) -> bool:
    with open(path) as f:
        spec = json.load(f)

    result = validator.validate_spec(spec)

    print(f"    {path.name}")
    print(f"    {why}")
    if result.valid:
        print("    ACCEPTED -- passed all three layers")
    else:
        print(f"    REJECTED at {LAYERS.get(result.failed_layer, result.failed_layer)}")
        for error in result.errors:
            print(f"      - {error}")
    print()
    return result.valid


def main() -> int:
    print()
    print("    ScreenForge -- every spec is validated before it can render")
    print("    " + "-" * 66)
    print()

    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
        if not path.exists():
            print(f"    no such file: {path}\n")
            return 2
        check(path, "the spec you passed in")
        return 0

    for path, why in DEMO_ORDER:
        check(path, why)

    print("    " + "-" * 66)
    print("    Nothing was repaired. An invalid spec is reported, never fixed")
    print("    quietly, and never rendered.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
