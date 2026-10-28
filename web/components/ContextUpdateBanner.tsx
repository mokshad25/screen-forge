import type { ContextChanges, ReconcileReport } from "@/lib/spec";

function describeChanges(changes: ContextChanges | null): string {
  if (!changes) return "What changed isn't available.";
  const parts: string[] = [];
  const add = (verb: string, noun: string, items: string[]) => {
    if (items.length > 0) parts.push(`${verb} ${noun}${items.length > 1 ? "s" : ""} ${items.join(", ")}`);
  };
  add("added", "tag", changes.tags_added);
  add("removed", "tag", changes.tags_removed);
  add("added", "alarm", changes.alarms_added);
  add("removed", "alarm", changes.alarms_removed);
  add("added", "device", changes.comms_added);
  add("removed", "device", changes.comms_removed);
  if (parts.length === 0) return "No tags, alarms or devices were added or removed.";
  const sentence = parts.join("; ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

export interface StaleScreen {
  from: string;
  to: string;
  /** POST /reconcile for the screen on display; null while it loads or if it failed. */
  report: ReconcileReport | null;
  reportFailed: boolean;
}

interface ContextUpdateBannerProps {
  stale: StaleScreen | null;
  /** The reconcile report a regeneration answered, once the new screen is on display. */
  regenerated: ReconcileReport | null;
  running: boolean;
  onRegenerate: () => void;
}

export function ContextUpdateBanner({ stale, regenerated, running, onRegenerate }: ContextUpdateBannerProps) {
  if (stale) {
    let detail = "Checking what changed…";
    if (stale.report) detail = describeChanges(stale.report.changes);
    else if (stale.reportFailed) detail = "Couldn't ask the API what changed.";
    const broken = stale.report?.broken_bindings ?? [];

    return (
      <section
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-neutral-fill/60 bg-surface px-4 py-3 text-sm text-text"
      >
        <span aria-hidden className={`size-2.5 shrink-0 rounded-full bg-neutral-fill ${running ? "sf-pulse" : ""}`} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            Machine context updated: <span className="numeral">{stale.from}</span> → <span className="numeral">{stale.to}</span>
          </p>
          <p className="text-muted">
            {detail} {running ? `Regenerating the screen against ${stale.to}…` : `This screen was built for ${stale.from}.`}
          </p>
          {broken.length > 0 && (
            <p className="numeral mt-1 text-xs text-muted">
              No longer in {stale.to}: {broken.map((b) => `${b.component_id} ${b.field}=${b.value}`).join(", ")}
            </p>
          )}
        </div>
        {!running && (
          <button
            type="button"
            onClick={onRegenerate}
            className="shrink-0 rounded-md border border-cell-border px-3 py-1.5 text-sm font-semibold text-text hover:border-neutral-fill"
          >
            Regenerate screen
          </button>
        )}
      </section>
    );
  }

  if (regenerated) {
    return (
      <section role="status" aria-live="polite" className="rounded-lg border border-cell-border bg-surface px-4 py-3 text-sm text-text">
        <span className="font-semibold">
          ↻ Screen regenerated for <span className="numeral">{regenerated.current_context_version}</span>
        </span>{" "}
        <span className="text-muted">
          · context updated from <span className="numeral">{regenerated.spec_context_version}</span>.{" "}
          {describeChanges(regenerated.changes)}
        </span>
      </section>
    );
  }

  return null;
}
