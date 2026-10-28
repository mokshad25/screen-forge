"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { clock } from "@/lib/format";
import { computeLayout, PANEL_RULES } from "@/lib/layout";
import type { MachineContext, PanelClass, ScreenSpec, TagsSnapshot } from "@/lib/spec";
import { bindingProblem, REGISTRY } from "./widgets";

/** Logical width each panel class is drawn at, before scaling to fit. */
export const PANEL_WIDTH: Record<PanelClass, number> = { small: 480, medium: 800, large: 1200 };

/** Draws children at a panel's logical width and scales them down to fit. Purely visual. */
export function ScaleToFit({ width, children }: { width: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; height?: number }>({ scale: 1 });
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const ro = new ResizeObserver(() => {
      const scale = Math.min(1, o.clientWidth / width);
      setFit({ scale, height: i.offsetHeight * scale });
    });
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={outer} className="relative mx-auto w-full overflow-hidden" style={{ maxWidth: width, height: fit.height }}>
      <div ref={inner} style={{ width, transform: `scale(${fit.scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}

interface ScreenViewProps {
  spec: ScreenSpec;
  context: MachineContext;
  panel: PanelClass;
  snapshot: TagsSnapshot | undefined;
  history: Record<string, (number | null)[]>;
  assetNames: Record<string, string>;
  onNavigate?: (assetId: string) => void;
  onAck?: (alarmId: string) => void;
  /** Component ids to outline briefly after an edit, so the change is visible. */
  changed?: Set<string>;
}

export function ScreenView({ spec, context, panel, snapshot, history, assetNames, onNavigate, onAck, changed }: ScreenViewProps) {
  const layout = computeLayout(spec, panel);
  const rule = PANEL_RULES[panel];
  const knownAssets = Object.keys(assetNames);
  return (
    <div className="bg-bezel p-2.5 pt-1.5 shadow-[0_1px_0_#fff6_inset]" data-panel={panel}>
      <p className="mb-1 flex justify-between px-1 text-[11px] text-chrome-2">
        <span>
          {rule.diagonal} panel, {rule.columns} {rule.columns === 1 ? "column" : "columns"}
        </span>
        <span>{rule.maxPriority === null ? "every priority" : `priority 1 to ${rule.maxPriority}`}</span>
      </p>
      <div className="bg-canvas p-3">
        <header className="mb-3 flex items-end justify-between gap-4 border-b border-rule pb-2">
          <div className="min-w-0">
            <p className="truncate text-xs text-ink-2">{context.asset_hierarchy.join(" / ")}</p>
            <h2 className="cond line-clamp-2 text-[26px] font-semibold leading-tight">{spec.title}</h2>
          </div>
          <div className="shrink-0 text-right">
            <p className="cond text-xl font-semibold">{snapshot ? clock(snapshot.timestamp) : "--:--:--"}</p>
            <p className="text-[11px] text-ink-2">Read only</p>
          </div>
        </header>
        <div className="flex flex-col gap-2.5">
          {layout.rows.map((row, r) => (
            <div key={r} className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}>
              {row.items.map(({ component, span, height }, i) => {
                const entry = REGISTRY[component.type];
                const problem = entry ? bindingProblem(component, context, knownAssets) : `unknown type ${component.type}`;
                // A short row that doesn't fill the panel stretches its last item rather than leaving a hole.
                const last = i === row.items.length - 1;
                const colSpan = last ? span + (layout.columns - row.usedColumns) : span;
                const minHeight = entry?.fit ? undefined : height === "short" ? 118 : Math.max(entry?.tall ?? 0, 200);
                return (
                  <div key={component.id} style={{ gridColumn: `span ${colSpan}`, minHeight }}
                    className={changed?.has(component.id) ? "outline outline-2 outline-offset-2 outline-control sf-arrive" : undefined}>
                    {problem || !entry ? (
                      <div className="flex h-full flex-col justify-center border border-dashed border-ink-2 bg-well p-3 text-sm">
                        <p className="font-semibold">Not drawn: {problem}</p>
                        <p className="text-ink-2">The screen was built for an older version of this machine. Update it to redraw.</p>
                      </div>
                    ) : (
                      <entry.Widget component={component} context={context} snapshot={snapshot} history={history}
                        assetNames={assetNames} onNavigate={onNavigate} onAck={onAck} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {layout.hidden.length > 0 && (
          <p className="mt-3 text-xs text-ink-2">
            Not shown on this panel: {layout.hidden.map((h) => REGISTRY[h.component.type]?.label.toLowerCase() ?? h.component.type).join(", ")}
            {" "}(lower priority or needs a larger panel).
          </p>
        )}
      </div>
    </div>
  );
}
