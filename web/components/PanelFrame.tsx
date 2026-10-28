import type { ReactNode } from "react";
import { PANEL_RULES } from "@/lib/layout";
import type { MachineContext, PanelClass, ScreenSpec, TagsSnapshot } from "@/lib/spec";

/** Logical CSS width each panel class is drawn at before ScaleToFit. */
export const PANEL_NOMINAL_WIDTH: Record<PanelClass, number> = {
  small: 460,
  medium: 780,
  large: 1180,
};

/** /tags timestamps arrive as ISO text or as Unix seconds (the /api simulator). */
function clock(timestamp: string | number): string {
  const date = typeof timestamp === "number" ? new Date(timestamp * 1000) : new Date(timestamp);
  return date.toLocaleTimeString([], { hour12: false });
}

interface PanelFrameProps {
  panel: PanelClass;
  spec: ScreenSpec;
  context: MachineContext;
  snapshot: TagsSnapshot | null;
  children: ReactNode;
}

export function PanelFrame({ panel, spec, context, snapshot, children }: PanelFrameProps) {
  const rule = PANEL_RULES[panel];
  const breadcrumb = context.asset_hierarchy.join(" › ");
  const time = snapshot ? clock(snapshot.timestamp) : "--:--:--";

  return (
    <div className="rounded-2xl bg-bezel p-3 ring-1 ring-cell-border" data-panel-frame={panel}>
      <div className="mb-2 flex items-center justify-between gap-3 px-1 text-[11px] font-semibold uppercase tracking-widest text-faint">
        <span>
          {rule.diagonal} {panel} panel
        </span>
        <span>
          {rule.columns} col · {rule.maxPriority === null ? "all priorities" : `priority ≤ ${rule.maxPriority}`}
        </span>
      </div>
      <div className="rounded-lg bg-surface p-3">
        <header className="mb-3 flex items-end justify-between gap-3 border-b border-cell-border pb-2">
          <div className="min-w-0">
            <p className="truncate text-[11px] uppercase tracking-wider text-faint">{breadcrumb}</p>
            {/* Wraps to two lines rather than cutting the title off on a 7" panel. */}
            <h2 className="line-clamp-2 break-words text-xl font-bold leading-tight text-text">{spec.title}</h2>
          </div>
          <div className="shrink-0 text-right">
            <p className="numeral text-lg font-semibold text-text">{time}</p>
            <p className="numeral text-[11px] text-faint">{spec.context_version} · read-only</p>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
