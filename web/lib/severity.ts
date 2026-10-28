// Alarm severity is the only thing a rendered screen uses colour for.

import type { AlarmDef, AlarmPriority, MachineContext, TagsSnapshot } from "./spec";

export type Severity = AlarmPriority;

const RANK: Record<Severity, number> = { Critical: 1, High: 2, Warning: 3 };

export const SEVERITY_COLOR: Record<Severity, string> = {
  Critical: "var(--sev-1)",
  High: "var(--sev-2)",
  Warning: "var(--sev-3)",
};

/** Most severe first. */
export function compareSeverity(a: AlarmDef, b: AlarmDef): number {
  return RANK[a.priority] - RANK[b.priority];
}

/** Alarms on this tag that are active in the snapshot, most severe first. */
export function activeAlarmsOnTag(context: MachineContext, snapshot: TagsSnapshot | null, tagName: string): AlarmDef[] {
  if (!snapshot) return [];
  return context.alarms.filter((a) => a.tag === tagName && snapshot.alarms[a.id] === true).sort(compareSeverity);
}

export function worstSeverity(alarms: AlarmDef[]): Severity | null {
  return [...alarms].sort(compareSeverity)[0]?.priority ?? null;
}
