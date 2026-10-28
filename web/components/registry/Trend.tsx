import { clamp, displayRange, displayUnit, findTag, formatNumber, formatValue, tagTitle } from "@/lib/format";
import { activeAlarmsOnTag, SEVERITY_COLOR, worstSeverity } from "@/lib/severity";
import { HISTORY_CAPACITY } from "@/lib/useLiveTags";
import { CellFrame } from "./CellFrame";
import type { RegistryProps } from "./types";

const W = 600;
const H = 200;

export function Trend({ component, context, live }: RegistryProps) {
  const tagName = component.bind_tag ?? "";
  const tag = findTag(context, tagName);
  const samples = live.history[tagName] ?? [];
  const severity = worstSeverity(activeAlarmsOnTag(context, live.snapshot, tagName));
  const range = displayRange(tag, samples);
  const span = range.max - range.min || 1;
  const y = (v: number) => H - ((clamp(v, range.min, range.max) - range.min) / span) * H;
  // Newest sample on the right edge; the line grows in from the left.
  const x = (i: number) => W - (samples.length - 1 - i) * (W / (HISTORY_CAPACITY - 1));
  const points = samples.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const current = live.snapshot?.tags[tagName];
  const low = samples.length > 0 ? Math.min(...samples) : null;
  const high = samples.length > 0 ? Math.max(...samples) : null;

  return (
    <CellFrame title={tagTitle(tagName)} binding={tagName} severity={severity}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span
            className="numeral text-4xl font-bold leading-none"
            style={{ color: severity ? SEVERITY_COLOR[severity] : "var(--text)" }}
          >
            {formatValue(current)}
          </span>
          <span className="text-sm text-muted">{displayUnit(tag.unit)}</span>
        </div>
        <span className="numeral text-xs text-faint">
          {low !== null && high !== null
            ? `min ${formatNumber(low)} · max ${formatNumber(high)} · last ${HISTORY_CAPACITY} s`
            : `last ${HISTORY_CAPACITY} s`}
        </span>
      </div>
      <div className="relative min-h-[120px] flex-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Trend of ${tagTitle(tagName)} over the last ${HISTORY_CAPACITY} seconds`}
        >
          <rect x={0} y={0} width={W} height={H} fill="none" stroke="var(--track)" vectorEffect="non-scaling-stroke" />
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--track)" vectorEffect="non-scaling-stroke" />
          ))}
          {samples.length > 1 && (
            <polyline
              points={points}
              fill="none"
              stroke={severity ? SEVERITY_COLOR[severity] : "var(--neutral-fill)"}
              strokeWidth={2.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <span className="numeral absolute left-1.5 top-1 text-[10px] text-faint">{range.max}</span>
        <span className="numeral absolute bottom-1 left-1.5 text-[10px] text-faint">{range.min}</span>
        {samples.length < 2 && (
          <p className="absolute inset-0 grid place-items-center text-sm text-faint">Collecting samples…</p>
        )}
      </div>
    </CellFrame>
  );
}
