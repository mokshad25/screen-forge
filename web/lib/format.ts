import type { AlarmDef, AlarmPriority, MachineContext, TagDef, TagValue, TagsSnapshot } from "./spec";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function findTag(context: MachineContext, name: string): TagDef {
  return context.tags.find((t) => t.name === name) ?? { name, type: "analog", access: "read" };
}

/** "Chilled_Water_Supply_Temp" -> "Chilled water supply temp"; "Compressor_RunStatus" -> "Compressor run status". */
export function tagTitle(tag: TagDef | string): string {
  const name = typeof tag === "string" ? tag : tag.name;
  const words = name
    .replace(/_PV$|_SP$/, "")
    .split("_")
    .filter(Boolean)
    .flatMap((w) => (/^[A-Z0-9]+$/.test(w) ? [w] : w.split(/(?<=[a-z])(?=[A-Z])/)));
  const text = words.map((w, i) => (/^[A-Z0-9]+$/.test(w) && w.length <= 4 ? w : i === 0 ? w : w.toLowerCase())).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function displayUnit(unit: string | undefined): string {
  if (unit === "degC") return "°C";
  return unit ?? "";
}

/**
 * The engineering range from the machine context. A gauge is never scaled to
 * recent history: a value that looks mid-scale has to BE mid-scale. Only a
 * tag without a range falls back, and says so.
 */
export function engineeringRange(tag: TagDef): { min: number; max: number; assumed: boolean } {
  if (tag.range) return { min: tag.range.low, max: tag.range.high, assumed: false };
  return { min: 0, max: tag.unit === "%" ? 100 : 100, assumed: true };
}

export function formatNumber(value: number, span = 100): string {
  if (span <= 10) return value.toFixed(2);
  if (Math.abs(value) >= 100 || span >= 200) return value.toFixed(0);
  return value.toFixed(1);
}

export function formatValue(value: TagValue | undefined, span?: number): string {
  if (value === undefined || value === null) return "--";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return formatNumber(value, span);
}

/** Alarm limits on an analog tag, for limit marks on indicators and trends. */
export function alarmLimits(context: MachineContext, tagName: string): { value: number; alarm: AlarmDef }[] {
  return context.alarms
    .filter((a) => a.tag === tagName && typeof a.condition.value === "number" && a.condition.op !== "==" && a.condition.op !== "!=")
    .map((a) => ({ value: a.condition.value as number, alarm: a }));
}

export const PRIORITY_RANK: Record<AlarmPriority, number> = { Critical: 1, High: 2, Warning: 3 };

export const PRIORITY_COLOR: Record<AlarmPriority, string> = {
  Critical: "var(--alarm-1)",
  High: "var(--alarm-2)",
  Warning: "var(--alarm-3)",
};

/** Alarms on this tag that are active now, most severe first. */
export function activeAlarmsOn(context: MachineContext, snapshot: TagsSnapshot | undefined, tagName: string): AlarmDef[] {
  if (!snapshot) return [];
  return context.alarms
    .filter((a) => a.tag === tagName && snapshot.alarms[a.id])
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

export function quality(snapshot: TagsSnapshot | undefined, tagName: string): "good" | "bad" | "none" {
  if (!snapshot) return "none";
  const q = snapshot.quality?.[tagName];
  if (q === "good") return "good";
  return "bad";
}

export function clock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour12: false });
}

export function ago(epochSeconds: number | null, now = Date.now() / 1000): string {
  if (!epochSeconds) return "";
  const s = Math.max(0, Math.round(now - epochSeconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}
