"use client";

import { ago, displayUnit, findTag, formatValue, PRIORITY_RANK } from "@/lib/format";
import type { MachineContext, TagsSnapshot } from "@/lib/spec";
import { AlarmShape } from "./AlarmShape";

export interface AlarmRow {
  assetId: string;
  assetName: string;
  alarmId: string;
}

/**
 * Alarm summary for the whole plant (ISA-18.2 style): every active alarm,
 * most severe first, with how long it has been active, the value now, and
 * the two things an operator does with an alarm -- acknowledge it, and open
 * the screen for working it.
 */
export function AlarmPanel({
  contexts,
  snapshots,
  assetNames,
  onAck,
  onOpenScreen,
}: {
  contexts: Record<string, MachineContext>;
  snapshots: Record<string, TagsSnapshot>;
  assetNames: Record<string, string>;
  onAck: (assetId: string, alarmId: string) => void;
  onOpenScreen: (assetId: string, alarmId: string) => void;
}) {
  const rows = Object.values(snapshots)
    .flatMap((snap) =>
      Object.entries(snap.alarm_states ?? {})
        .filter(([, s]) => s.active)
        .map(([alarmId, s]) => ({ snap, alarmId, s })),
    )
    .sort((a, b) => PRIORITY_RANK[a.s.priority] - PRIORITY_RANK[b.s.priority] || (a.s.since ?? 0) - (b.s.since ?? 0));

  if (rows.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-2">No active alarms on any machine.</p>;
  }
  return (
    <ul className="divide-y divide-rule">
      {rows.map(({ snap, alarmId, s }) => {
        const ctx = contexts[snap.asset_id];
        const value = snap.tags[s.tag];
        const unit = ctx ? displayUnit(findTag(ctx, s.tag).unit) : "";
        return (
          <li key={`${snap.asset_id}/${alarmId}`} className="px-4 py-2.5">
            <div className="flex items-start gap-2.5">
              <AlarmShape priority={s.priority} acked={s.acked} size={20} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold leading-tight">{s.desc}</p>
                <p className="text-xs text-ink-2">
                  {assetNames[snap.asset_id] ?? snap.asset_id}, {alarmId}, active {ago(s.since)}
                </p>
                <p className="mt-0.5 text-sm">
                  Now <span className="cond font-semibold">{formatValue(value)} {unit}</span>
                  {s.quality !== "good" && <span className="ml-2 font-semibold text-bad-q">bad quality, state held</span>}
                </p>
              </div>
            </div>
            <div className="mt-2 flex gap-2 pl-[30px]">
              <button type="button" onClick={() => onOpenScreen(snap.asset_id, alarmId)}
                className="bg-control px-2.5 py-1 text-xs font-semibold text-white hover:brightness-110">
                Open alarm screen
              </button>
              {s.acked ? (
                <span className="px-1 py-1 text-xs text-ink-2">Acknowledged</span>
              ) : (
                <button type="button" onClick={() => onAck(snap.asset_id, alarmId)}
                  className="border border-ink-2 px-2.5 py-1 text-xs font-semibold hover:bg-chrome">
                  Acknowledge
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
