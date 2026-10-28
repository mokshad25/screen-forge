import type { ReactNode } from "react";
import { SEVERITY_COLOR, type Severity } from "@/lib/severity";

interface CellFrameProps {
  title: string;
  binding: string;
  severity: Severity | null;
  badge?: string;
  children: ReactNode;
}

export function CellFrame({ title, binding, severity, badge, children }: CellFrameProps) {
  const color = severity ? SEVERITY_COLOR[severity] : undefined;
  return (
    <section
      aria-label={title}
      className="flex h-full min-w-0 flex-col rounded-lg border bg-cell p-4"
      style={{
        borderColor: color ?? "var(--cell-border)",
        boxShadow: color ? `inset 5px 0 0 ${color}` : undefined,
      }}
    >
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold uppercase tracking-wide text-muted">{title}</h3>
          <p className="numeral truncate text-xs text-faint">{binding}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge && (
            <span className="rounded border border-cell-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {badge}
            </span>
          )}
          {severity && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-bezel"
              style={{ background: color }}
            >
              {severity}
            </span>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
