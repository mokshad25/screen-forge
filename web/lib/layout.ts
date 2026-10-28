// Responsive layout engine. Derives an ordered, row-packed layout from a screen
// spec and a panel class, using ONLY priority, size_hint and min_panel.
// The spec has no position or size data (CLAUDE.md invariant 2), and this file
// must never start reading any. Rules are the ones recorded in the x-screenforge
// header of contracts/screen-spec.schema.json.

import type { PanelClass, ScreenSpec, SizeHint, SpecComponent } from "./spec";

export const PANEL_CLASSES: PanelClass[] = ["small", "medium", "large"];

export interface PanelRule {
  diagonal: string;
  columns: number;
  /** null means no priority limit. */
  maxPriority: number | null;
}

export const PANEL_RULES: Record<PanelClass, PanelRule> = {
  small: { diagonal: '7"', columns: 1, maxPriority: 3 },
  medium: { diagonal: '10"', columns: 2, maxPriority: 6 },
  large: { diagonal: '15"+', columns: 3, maxPriority: null },
};

const PANEL_RANK: Record<PanelClass, number> = { small: 0, medium: 1, large: 2 };

export type CellHeight = "short" | "tall";

export interface LayoutItem {
  component: SpecComponent;
  /** Columns this component asks for on this panel class. */
  span: number;
  height: CellHeight;
}

export interface LayoutRow {
  items: LayoutItem[];
  /** Sum of spans. Less than the panel's columns means the row grows to fill. */
  usedColumns: number;
}

export interface HiddenItem {
  component: SpecComponent;
  reasons: string[];
}

export interface Layout {
  panel: PanelClass;
  columns: number;
  rows: LayoutRow[];
  hidden: HiddenItem[];
}

export function spanFor(hint: SizeHint, columns: number): number {
  return hint === "wide" ? columns : 1;
}

export function heightFor(hint: SizeHint): CellHeight {
  return hint === "compact" ? "short" : "tall";
}

export function hiddenReasons(component: SpecComponent, panel: PanelClass): string[] {
  const rule = PANEL_RULES[panel];
  const minPanel = component.min_panel ?? "small";
  const reasons: string[] = [];
  if (rule.maxPriority !== null && component.priority > rule.maxPriority) {
    reasons.push(`priority ${component.priority} is above the ${panel} panel limit of ${rule.maxPriority}`);
  }
  if (PANEL_RANK[minPanel] > PANEL_RANK[panel]) {
    reasons.push(`min_panel is ${minPanel}`);
  }
  return reasons;
}

export function computeLayout(spec: ScreenSpec, panel: PanelClass): Layout {
  const { columns } = PANEL_RULES[panel];
  const visible: { component: SpecComponent; index: number }[] = [];
  const hidden: { item: HiddenItem; index: number }[] = [];

  spec.components.forEach((component, index) => {
    const reasons = hiddenReasons(component, panel);
    if (reasons.length > 0) {
      hidden.push({ item: { component, reasons }, index });
    } else {
      visible.push({ component, index });
    }
  });

  // Ascending priority; ties keep their order in the components array.
  const byPriority = (a: { component: SpecComponent; index: number }, b: { component: SpecComponent; index: number }) =>
    a.component.priority - b.component.priority || a.index - b.index;
  visible.sort(byPriority);
  hidden.sort((a, b) => a.item.component.priority - b.item.component.priority || a.index - b.index);

  // Greedy row packing in priority order. Never reorder to fill gaps.
  const rows: LayoutRow[] = [];
  let current: LayoutRow = { items: [], usedColumns: 0 };
  for (const { component } of visible) {
    const span = spanFor(component.size_hint, columns);
    if (current.items.length > 0 && current.usedColumns + span > columns) {
      rows.push(current);
      current = { items: [], usedColumns: 0 };
    }
    current.items.push({ component, span, height: heightFor(component.size_hint) });
    current.usedColumns += span;
  }
  if (current.items.length > 0) rows.push(current);

  return { panel, columns, rows, hidden: hidden.map((h) => h.item) };
}
