import { clamp, displayRange, displayUnit, findTag, formatValue, tagTitle } from "@/lib/format";
import { activeAlarmsOnTag, SEVERITY_COLOR, worstSeverity } from "@/lib/severity";
import { CellFrame } from "./CellFrame";
import type { RegistryProps } from "./types";

// 240 degree dial, angles measured clockwise from 12 o'clock.
const START = -120;
const SWEEP = 240;
const CX = 100;
const CY = 100;
const R = 80;

function pointAt(deg: number, radius: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [CX + radius * Math.cos(rad), CY + radius * Math.sin(rad)];
}

function arcPath(from: number, to: number): string {
  const [x1, y1] = pointAt(from, R);
  const [x2, y2] = pointAt(to, R);
  const largeArc = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function Gauge({ component, context, live }: RegistryProps) {
  const tagName = component.bind_tag ?? "";
  const tag = findTag(context, tagName);
  const raw = live.snapshot?.tags[tagName];
  const severity = worstSeverity(activeAlarmsOnTag(context, live.snapshot, tagName));
  const range = displayRange(tag, live.history[tagName]);
  const fraction = typeof raw === "number" ? clamp((raw - range.min) / (range.max - range.min || 1), 0, 1) : 0;
  const valueColor = severity ? SEVERITY_COLOR[severity] : "var(--neutral-fill)";
  const text = formatValue(raw);
  const unit = displayUnit(tag.unit);
  const [minX] = pointAt(START, R);
  const [maxX] = pointAt(START + SWEEP, R);

  return (
    <CellFrame
      title={tagTitle(tagName)}
      binding={tagName}
      severity={severity}
      badge={tag.access === "write" ? "Write tag · shown read-only" : undefined}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <svg viewBox="0 0 200 160" className="h-full max-h-64 w-full" role="img" aria-label={`${tagTitle(tagName)}: ${text} ${unit}`}>
          <path d={arcPath(START, START + SWEEP)} fill="none" stroke="var(--track)" strokeWidth={14} strokeLinecap="round" />
          {fraction > 0.002 && (
            <path
              d={arcPath(START, START + SWEEP * fraction)}
              fill="none"
              stroke={valueColor}
              strokeWidth={14}
              strokeLinecap="round"
            />
          )}
          <text
            x={CX}
            y={CY + 6}
            textAnchor="middle"
            className="numeral"
            fontSize={40}
            fontWeight={700}
            fill={severity ? valueColor : "var(--text)"}
          >
            {text}
          </text>
          <text x={CX} y={CY + 28} textAnchor="middle" fontSize={14} fill="var(--text-muted)">
            {unit}
          </text>
          <text x={minX} y={157} textAnchor="middle" className="numeral" fontSize={12} fill="var(--text-faint)">
            {range.min}
          </text>
          <text x={maxX} y={157} textAnchor="middle" className="numeral" fontSize={12} fill="var(--text-faint)">
            {range.max}
          </text>
        </svg>
      </div>
    </CellFrame>
  );
}
