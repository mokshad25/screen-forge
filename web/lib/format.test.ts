import assert from "node:assert/strict";
import { test } from "node:test";
import { alarmLimits, engineeringRange, formatValue, quality, tagTitle } from "./format.ts";
import type { MachineContext, TagsSnapshot } from "./spec.ts";

const ctx = {
  asset_id: "a", context_version: "v1", asset_hierarchy: ["P", "M"], io: {}, comms: [],
  tags: [
    { name: "Condenser_Pressure", type: "analog", unit: "bar", access: "read", range: { low: 0, high: 16 } },
    { name: "No_Range_PV", type: "analog", access: "read" },
  ],
  alarms: [
    { id: "HP", desc: "High", priority: "Critical", tag: "Condenser_Pressure", condition: { op: ">", value: 11 } },
    { id: "TR", desc: "Trip", priority: "High", tag: "Run", condition: { op: "==", value: false } },
  ],
} as MachineContext;

test("tag names read as sentence case words", () => {
  assert.equal(tagTitle("Chilled_Water_Supply_Temp"), "Chilled water supply temp");
  assert.equal(tagTitle("Compressor_RunStatus"), "Compressor run status");
  assert.equal(tagTitle("PLC1_Health"), "PLC1 health");
  assert.equal(tagTitle("Refrigerant_Level_PV"), "Refrigerant level");
});

test("gauges use the engineering range, and say when there isn't one", () => {
  assert.deepEqual(engineeringRange(ctx.tags[0]), { min: 0, max: 16, assumed: false });
  assert.equal(engineeringRange(ctx.tags[1]).assumed, true);
});

test("only numeric threshold alarms become limit marks", () => {
  assert.deepEqual(alarmLimits(ctx, "Condenser_Pressure").map((l) => l.value), [11]);
  assert.deepEqual(alarmLimits(ctx, "Run"), []);
});

test("missing values never render as zero", () => {
  assert.equal(formatValue(null), "--");
  assert.equal(formatValue(undefined), "--");
  assert.equal(formatValue(0), "0.0");
});

test("anything but good quality is shown as bad", () => {
  const snap = { quality: { A: "good", B: "bad", C: "n/a" } } as unknown as TagsSnapshot;
  assert.equal(quality(snap, "A"), "good");
  assert.equal(quality(snap, "B"), "bad");
  assert.equal(quality(snap, "Missing"), "bad");
});
