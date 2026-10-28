import type { MachineContext, TagDef, TagValue } from "./spec";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function findTag(context: MachineContext, name: string): TagDef {
  // The renderer checks bindings against the context before a component renders,
  // so the fallback only keeps the types honest.
  return context.tags.find((t) => t.name === name) ?? { name, type: "analog", access: "read" };
}

export function tagTitle(name: string): string {
  return name.replaceAll("_", " ");
}

export function displayUnit(unit: string | undefined): string {
  if (unit === "degC") return "°C";
  return unit ?? "";
}

// The contract carries no engineering ranges, so dial and trend scales are a
// display choice. Before any samples arrive: a default per unit. After: the
// smallest step on a coarse ladder with headroom above the recent values, so a
// 7 °C chilled-water reading isn't lost on a 0-120 °C dial. The ladder is coarse
// on purpose -- normal drift never moves the scale, only a real excursion does.
const UNIT_RANGE: Record<string, { min: number; max: number }> = {
  degC: { min: 0, max: 120 },
  bar: { min: 0, max: 25 },
  "m/s": { min: 0, max: 5 },
  "%": { min: 0, max: 100 },
};

const SCALE_LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const HEADROOM = 1.5;

function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

export function displayRange(tag: TagDef, samples: number[] = []): { min: number; max: number } {
  const base = UNIT_RANGE[tag.unit ?? ""] ?? { min: 0, max: 100 };
  if (samples.length === 0) return base;
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  const min = low < 0 ? -niceCeil(-low) : 0;
  // Percentages keep their natural 0-100 scale.
  if (tag.unit === "%") return { min, max: Math.max(100, niceCeil(high)) };
  const wanted = high * HEADROOM;
  return { min, max: SCALE_LADDER.find((step) => step >= wanted) ?? niceCeil(wanted) };
}

export function formatNumber(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function formatValue(value: TagValue | undefined): string {
  if (value === undefined) return "--";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  return formatNumber(value);
}
