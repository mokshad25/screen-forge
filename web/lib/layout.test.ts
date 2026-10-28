// Run with: npm test   (node's built-in runner; Node 22 strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLayout } from "./layout.ts";
import type { ScreenSpec, SpecComponent } from "./spec.ts";

function spec(...components: Partial<SpecComponent>[]): ScreenSpec {
  return {
    screen_id: "t",
    title: "t",
    asset_id: "a",
    context_version: "v1",
    permissions: { mode: "read_only" },
    components: components.map((c, i) => ({ id: `c${i + 1}`, type: "gauge", priority: i + 1, size_hint: "medium", ...c })) as SpecComponent[],
  };
}

test("a 7 inch panel shows priority 1 to 3 in one column", () => {
  const layout = computeLayout(spec({}, {}, {}, {}, {}), "small");
  assert.equal(layout.columns, 1);
  assert.deepEqual(layout.rows.map((r) => r.items[0].component.id), ["c1", "c2", "c3"]);
  assert.deepEqual(layout.hidden.map((h) => h.component.id), ["c4", "c5"]);
});

test("min_panel hides a component on smaller panels and says why", () => {
  const layout = computeLayout(spec({ type: "trend", min_panel: "medium" }, {}), "small");
  assert.equal(layout.hidden[0].component.id, "c1");
  assert.match(layout.hidden[0].reasons[0], /min_panel is medium/);
  assert.equal(computeLayout(spec({ type: "trend", min_panel: "medium" }), "medium").hidden.length, 0);
});

test("wide always takes a full row; others pack greedily in priority order", () => {
  const layout = computeLayout(spec({ size_hint: "compact" }, { size_hint: "wide" }, {}, {}, {}, {}), "large");
  assert.deepEqual(
    layout.rows.map((r) => r.items.map((i) => i.component.id)),
    [["c1"], ["c2"], ["c3", "c4", "c5"], ["c6"]],
  );
});

test("priority ties keep the spec's order, and the spec is never reordered to fill gaps", () => {
  const layout = computeLayout(spec({ priority: 2 }, { priority: 1 }, { priority: 2 }), "medium");
  assert.deepEqual(layout.rows.flatMap((r) => r.items.map((i) => i.component.id)), ["c2", "c1", "c3"]);
});

test("the layout depends only on priority, size_hint and min_panel", () => {
  const a = computeLayout(spec({ bind_tag: "X" }, { bind_tag: "Y" }), "large");
  const b = computeLayout(spec({ bind_tag: "Q" }, { bind_tag: "R" }), "large");
  assert.deepEqual(a.rows.map((r) => r.usedColumns), b.rows.map((r) => r.usedColumns));
});
