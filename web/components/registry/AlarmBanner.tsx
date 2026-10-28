import { compareSeverity, SEVERITY_COLOR } from "@/lib/severity";
import type { RegistryProps } from "./types";

export function AlarmBanner({ component, context, live }: RegistryProps) {
  const rows = (component.bind_alarms ?? []).flatMap((id) => {
    const def = context.alarms.find((a) => a.id === id);
    return def ? [{ def, active: live.snapshot?.alarms[id] === true }] : [];
  });
  const active = rows.filter((r) => r.active).sort((a, b) => compareSeverity(a.def, b.def));
  const ordered = [...active, ...rows.filter((r) => !r.active)];
  const worst = active[0]?.def.priority ?? null;
  const color = worst ? SEVERITY_COLOR[worst] : undefined;

  let headline = "No active alarms";
  if (live.snapshot === null) headline = "Waiting for live data";
  else if (active.length > 0) headline = `${active.length} active alarm${active.length > 1 ? "s" : ""}`;

  return (
    <section
      aria-label="Alarm banner"
      aria-live="polite"
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border bg-cell"
      style={{ borderColor: color ?? "var(--cell-border)" }}
    >
      <div
        className="flex items-center gap-3 px-4 py-2.5"
        style={color ? { background: color, color: "var(--bezel)" } : undefined}
      >
        <span
          aria-hidden
          className={`size-3 shrink-0 rounded-full ${worst ? "sf-pulse" : ""}`}
          style={{ background: worst ? "var(--bezel)" : "var(--text-faint)" }}
        />
        <span className="truncate text-lg font-bold uppercase tracking-wide">{headline}</span>
        <span className={`ml-auto shrink-0 text-xs font-semibold uppercase tracking-wider ${color ? "" : "text-faint"}`}>
          {worst ? `Highest: ${worst}` : `Monitoring ${rows.length}`}
        </span>
      </div>
      <ul className="divide-y divide-cell-border">
        {ordered.map(({ def, active: isActive }) => (
          <li key={def.id} className="flex items-center gap-3 px-4 py-2">
            <span
              className="w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-bold uppercase tracking-wider"
              style={
                isActive
                  ? { background: SEVERITY_COLOR[def.priority], color: "var(--bezel)" }
                  : { border: "1px solid var(--cell-border)", color: "var(--text-faint)" }
              }
            >
              {def.priority}
            </span>
            <span className={`min-w-0 flex-1 truncate ${isActive ? "font-semibold text-text" : "text-muted"}`}>
              {def.desc}
            </span>
            <span className="numeral shrink-0 text-xs text-faint">{def.id}</span>
            <span
              className="numeral w-14 shrink-0 text-right text-xs font-bold uppercase"
              style={{ color: isActive ? SEVERITY_COLOR[def.priority] : "var(--text-faint)" }}
            >
              {isActive ? "Active" : "Normal"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
