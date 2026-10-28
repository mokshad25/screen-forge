"""
Process model for the simulated plant.

Each analog signal drifts around a baseline and now and then takes an
excursion; each bool occasionally flips. Faults can be injected to hold a
signal at a value for a while, and network links can be pulled.

This is the PLANT, not ScreenForge. ScreenForge only ever reads it, over OPC
UA and Modbus TCP, exactly as it would read a real one.
"""

import random
import threading
import time
from dataclasses import dataclass


@dataclass
class Profile:
    baseline: float
    normal_swing: float
    excursion_chance: float = 0.0
    excursion_swing: float = 0.0  # negative: excursions only ever fall
    low: float | None = None
    high: float | None = None


PROFILES: dict[str, Profile] = {
    # Conveyor A (PLC1, Modbus)
    "Conveyor_Speed_SP": Profile(1.2, 0.05, 0.02, 0.4, 0, 2.5),
    "Temperature_PV": Profile(45.0, 1.0, 0.03, 20.0, 0, 100),
    "Pressure_Sensor": Profile(3.2, 0.08, 0.03, 2.0, 0, 6),
    # Chiller 1 (BMS over OPC UA, VFD over Modbus)
    "Chilled_Water_Supply_Temp": Profile(7.0, 0.2, 0.02, 4.0, 0, 20),
    "Chilled_Water_Return_Temp": Profile(12.0, 0.2, 0.02, 4.0, 0, 25),
    "Condenser_Pressure": Profile(9.0, 0.15, 0.03, 3.0, 0, 16),
    "Evaporator_Pressure": Profile(4.0, 0.1, 0.02, 1.2, 0, 8),
    "Refrigerant_Level_PV": Profile(85.0, 1.5, 0.01, -35.0, 0, 100),
    "Vibration_PV": Profile(2.4, 0.2, 0.03, 4.0, 0, 20),
    # AHU 1 (OPC UA only; not known to ScreenForge until imported)
    "Supply_Air_Temp": Profile(14.0, 0.3, 0.02, 6.0, 0, 40),
    "Return_Air_Temp": Profile(24.0, 0.3, 0.01, 4.0, 0, 40),
    "Filter_DP": Profile(140.0, 6.0, 0.02, 160.0, 0, 500),
    "Duct_Static_Pressure": Profile(450.0, 15.0, 0.02, 300.0, 0, 1500),
}

BOOLS_START_TRUE = {"Motor_1_RunStatus", "Compressor_RunStatus", "VFD1_Health", "Supply_Fan_Status"}
BOOL_FLIP_CHANCE = 0.004


class PlantModel:
    def __init__(self, signals: dict[str, str], seed: int | None = None):
        """signals: name -> 'analog' | 'bool'."""
        self._rng = random.Random(seed)
        self._lock = threading.Lock()
        self.values: dict[str, float | bool] = {}
        self.types = dict(signals)
        self.faults: dict[str, tuple[float | bool, float]] = {}
        self.links_down: set[str] = set()
        for name, kind in signals.items():
            if kind == "bool":
                self.values[name] = name in BOOLS_START_TRUE
            else:
                self.values[name] = PROFILES.get(name, Profile(50, 1)).baseline

    def step(self) -> dict[str, float | bool]:
        now = time.time()
        with self._lock:
            for name, kind in self.types.items():
                fault = self.faults.get(name)
                if fault and fault[1] > now:
                    self.values[name] = fault[0]
                    continue
                if fault:
                    del self.faults[name]
                if kind == "bool":
                    # A running machine occasionally trips and comes back a few
                    # seconds later; a trip that never cleared would leave every
                    # demo starting in alarm.
                    value = bool(self.values[name])
                    normally_on = name in BOOLS_START_TRUE
                    if value and self._rng.random() < BOOL_FLIP_CHANCE:
                        value = False
                    elif not value and normally_on and self._rng.random() < 0.15:
                        value = True
                    elif not value and not normally_on and self._rng.random() < BOOL_FLIP_CHANCE:
                        value = True
                    self.values[name] = value
                else:
                    self.values[name] = self._step_analog(name, float(self.values[name]))
            return dict(self.values)

    def _step_analog(self, name: str, current: float) -> float:
        p = PROFILES.get(name, Profile(50, 1))
        if p.excursion_chance and self._rng.random() < p.excursion_chance:
            swing = p.excursion_swing
            current += -abs(swing) if swing < 0 else self._rng.choice([-1, 1]) * swing
        else:
            current += self._rng.uniform(-1, 1) * p.normal_swing
        current += (p.baseline - current) * 0.06
        if p.low is not None:
            current = max(p.low, current)
        if p.high is not None:
            current = min(p.high, current)
        return round(current, 3)

    def inject_fault(self, name: str, value: float | bool, seconds: float) -> None:
        if name not in self.types:
            raise KeyError(name)
        with self._lock:
            if self.types[name] == "bool":
                value = bool(value)
            self.faults[name] = (value, time.time() + seconds)
            self.values[name] = value

    def clear_faults(self) -> None:
        with self._lock:
            self.faults.clear()
