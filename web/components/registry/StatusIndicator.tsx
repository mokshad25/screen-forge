import { formatValue, tagTitle } from "@/lib/format";
import { activeAlarmsOnTag, SEVERITY_COLOR, worstSeverity } from "@/lib/severity";
import { CellFrame } from "./CellFrame";
import type { RegistryProps } from "./types";

function stateLabels(tagName: string): [on: string, off: string] {
  if (/RunStatus|Running/i.test(tagName)) return ["Running", "Stopped"];
  if (/Health/i.test(tagName)) return ["Online", "Offline"];
  if (/_OK$/i.test(tagName)) return ["OK", "Not OK"];
  if (/Active|Detected|Fault|Trip/i.test(tagName)) return ["Active", "Clear"];
  return ["On", "Off"];
}

export function StatusIndicator({ component, context, live }: RegistryProps) {
  const tagName = component.bind_tag ?? "";
  const value = live.snapshot?.tags[tagName];
  const severity = worstSeverity(activeAlarmsOnTag(context, live.snapshot, tagName));
  const mark = severity ? SEVERITY_COLOR[severity] : "var(--neutral-fill)";
  const [onLabel, offLabel] = stateLabels(tagName);
  const label = typeof value === "boolean" ? (value ? onLabel : offLabel) : formatValue(value);

  return (
    <CellFrame title={tagTitle(tagName)} binding={tagName} severity={severity}>
      <div className="flex flex-1 items-center gap-4">
        <span
          aria-hidden
          className="size-9 shrink-0 rounded-full border-4"
          style={{ borderColor: mark, background: value === true || severity ? mark : "transparent" }}
        />
        <span
          className="numeral text-4xl font-bold uppercase leading-none tracking-tight"
          style={{ color: severity ? mark : "var(--text)" }}
        >
          {label}
        </span>
      </div>
    </CellFrame>
  );
}
