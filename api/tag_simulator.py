"""
Tag simulator.

Produces plausible live values for every tag in a machine context, without
any real hardware. This is the honest stand-in for a real PLC connection --
we say so openly in the pitch (see the project brief, Part 13).

How it behaves:
  - bool tags: usually stay put, occasionally flip (like a motor starting
    or stopping).
  - analog tags: drift slowly within a "normal" band around a baseline, and
    every so often take a bigger excursion outside that band -- which is
    what should trip an alarm. Alarm thresholds are NOT here: they live in
    the machine context (alarms[].condition) and are applied by alarms.py.

State is kept in memory, per asset_id, so values drift smoothly across
repeated calls instead of jumping around randomly every time someone asks.
"""

import random
import time

import alarms
import context_store

# Reasonable normal-operating baselines per tag name, used only by the
# simulator (a real PLC wouldn't need this -- it would just report reality).
# unit is informational only, taken from the tag's own definition.
# excursion_swing is a magnitude with a direction: a POSITIVE value can jump
# either way, a NEGATIVE one only ever falls. Refrigerant level is the reason
# the distinction exists -- "low refrigerant" is the interesting story, and a
# tank that spontaneously fills itself isn't one.
_BASELINES = {
    "Conveyor_Speed_SP": {"baseline": 1.2, "normal_swing": 0.05, "excursion_chance": 0.03, "excursion_swing": 0.4},
    "Temperature_PV": {"baseline": 45.0, "normal_swing": 1.5, "excursion_chance": 0.05, "excursion_swing": 20.0},
    "Pressure_Sensor": {"baseline": 3.2, "normal_swing": 0.1, "excursion_chance": 0.05, "excursion_swing": 2.0},
    "Chilled_Water_Supply_Temp": {"baseline": 7.0, "normal_swing": 0.3, "excursion_chance": 0.03, "excursion_swing": 5.0},
    "Chilled_Water_Return_Temp": {"baseline": 12.0, "normal_swing": 0.3, "excursion_chance": 0.03, "excursion_swing": 5.0},
    "Condenser_Pressure": {"baseline": 9.0, "normal_swing": 0.2, "excursion_chance": 0.05, "excursion_swing": 3.0},
    "Evaporator_Pressure": {"baseline": 4.0, "normal_swing": 0.15, "excursion_chance": 0.03, "excursion_swing": 1.5},
    # Lower excursion_chance than the others on purpose: a fall of 40 takes
    # roughly 8 steps to recover from, so at 0.05 the level would settle near
    # 45 and ALM_LR01 would simply be on for good. At 0.015 it sits near
    # baseline and dips below the alarm threshold now and then, which is the
    # behaviour worth showing.
    "Refrigerant_Level_PV": {"baseline": 85.0, "normal_swing": 2.0, "excursion_chance": 0.015, "excursion_swing": -40.0},
    # Added to the chiller at runtime by the machine-change demo. Profiled
    # here so it reads like a real sensor the moment it appears, rather than
    # falling back to the flat default.
    "Vibration_PV": {"baseline": 2.4, "normal_swing": 0.25, "excursion_chance": 0.04, "excursion_swing": 4.0},
}

# Fallback for any analog tag we didn't hand-tune above (e.g. health tags
# treated as analog by mistake, or a tag added later) -- keeps the demo from
# crashing if someone adds a tag without updating this file.
_DEFAULT_ANALOG = {"baseline": 50.0, "normal_swing": 2.0, "excursion_chance": 0.02, "excursion_swing": 10.0}

# Physical limits, keyed by the tag's own unit rather than its name, so a tag
# that appears at runtime (the Phase 4 context bump adds one) is bounded
# without anyone editing this file. None means "no limit in that direction";
# degC is deliberately absent because chilled water legitimately goes below
# zero, while a percentage or a pressure below zero is a simulator bug.
_UNIT_LIMITS: dict[str, tuple[float | None, float | None]] = {
    "%": (0.0, 100.0),
    "bar": (0.0, None),
    "kpa": (0.0, None),
    "psi": (0.0, None),
    "m/s": (0.0, None),
    "mm/s": (0.0, None),
    "rpm": (0.0, None),
    "hz": (0.0, None),
}


def _clamp_to_unit(value: float, unit: str | None) -> float:
    """Hold a value inside what its unit can physically mean."""
    low, high = _UNIT_LIMITS.get((unit or "").strip().lower(), (None, None))
    if low is not None:
        value = max(low, value)
    if high is not None:
        value = min(high, value)
    return value

# Bool tags representing "is this machine currently running normally" should
# start True (running) so a demo doesn't open with a false trip alarm already
# active. Bool tags representing an operator command (Start/Stop buttons)
# should start False (nothing commanded yet). Anything else defaults to False.
_BOOL_STARTS_TRUE = {"Motor_1_RunStatus", "Compressor_RunStatus"}

# In-memory "current value" state, per asset_id -> tag name -> value.
_STATE: dict[str, dict[str, float | bool]] = {}

# Faults injected for a demo: asset_id -> tag -> (forced value, until epoch).
# A fault holds a tag at a value for a while, as a real excursion would, so
# an alarm stays up long enough for an operator to work it.
_FAULTS: dict[str, dict[str, tuple[float | bool, float]]] = {}


def inject_fault(asset_id: str, tag_name: str, value: float | bool, seconds: float = 20.0) -> None:
    """Hold one simulated tag at `value` for `seconds`, then let it recover."""
    _FAULTS.setdefault(asset_id, {})[tag_name] = (value, time.time() + seconds)


def clear_faults(asset_id: str | None = None) -> None:
    if asset_id is None:
        _FAULTS.clear()
    else:
        _FAULTS.pop(asset_id, None)


def _starting_value(tag: dict) -> float | bool:
    """The value a tag begins life at, whether at startup or mid-run."""
    if tag["type"] == "bool":
        return "Health" in tag["name"] or tag["name"] in _BOOL_STARTS_TRUE
    return _BASELINES.get(tag["name"], _DEFAULT_ANALOG)["baseline"]


def _sync_state_to_context(asset_id: str, ctx: dict) -> dict:
    """
    Bring the in-memory state in line with the context as it is RIGHT NOW,
    adding tags that have appeared and dropping ones that have gone.

    A context can change while the simulation is running -- that's the whole
    point of the machine-change demo -- and the state dict was built from the
    context as it looked at the first call. Without this, the first poll after
    a bump raises KeyError on the newly added tag.
    """
    state = _STATE.setdefault(asset_id, {})
    current_names = set()

    for tag in ctx["tags"]:
        current_names.add(tag["name"])
        if tag["name"] not in state:
            state[tag["name"]] = _starting_value(tag)

    for gone in set(state) - current_names:
        del state[gone]

    return state


def _step_bool(current: bool, tag_name: str) -> bool:
    # Health tags: rarely flip (a comms dropout should be a rare, noticeable
    # event, not constant flapping).
    flip_chance = 0.01 if "Health" in tag_name else 0.03
    if random.random() < flip_chance:
        return not current
    return current


def _step_analog(current: float, tag_name: str, unit: str | None = None) -> float:
    profile = _BASELINES.get(tag_name, _DEFAULT_ANALOG)
    swing = profile["excursion_swing"]
    if random.random() < profile["excursion_chance"]:
        # A bigger jump -- this is what should trip an alarm. A negative
        # excursion_swing falls only; a positive one can go either way.
        if swing < 0:
            current -= abs(swing)
        else:
            current += random.choice([-1, 1]) * swing
    else:
        # Normal small drift.
        current += random.uniform(-1, 1) * profile["normal_swing"]
    # Pull gently back toward baseline so it doesn't wander off forever.
    current += (profile["baseline"] - current) * 0.05
    return round(_clamp_to_unit(current, unit), 2)


def step(asset_id: str) -> dict[str, float | bool]:
    """Advance the simulation of one asset by one tick and return its tag values."""
    ctx = context_store.get_context(asset_id)
    state = _sync_state_to_context(asset_id, ctx)
    faults = _FAULTS.get(asset_id, {})
    now = time.time()

    for tag in ctx["tags"]:
        name = tag["name"]
        fault = faults.get(name)
        if fault and fault[1] > now:
            state[name] = fault[0]
            continue
        if fault:
            del faults[name]
        if tag["type"] == "bool":
            state[name] = _step_bool(state[name], name)
        else:
            state[name] = _step_analog(state[name], name, tag.get("unit"))
    return dict(state)


def get_live_values(asset_id: str) -> dict:
    """
    One simulation tick for asset_id, in the GET /tags shape. Alarm states are
    decided by the conditions in the machine context (alarms.py), the same
    rule the live OPC UA / Modbus path uses.
    """
    ctx = context_store.get_context(asset_id)
    values = step(asset_id)
    return {
        "asset_id": asset_id,
        "context_version": ctx["context_version"],
        "timestamp": time.time(),
        "tags": values,
        "alarms": alarms.evaluate_conditions(ctx, values),
    }
