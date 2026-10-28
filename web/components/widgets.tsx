"use client";

// The fixed vocabulary a screen spec is composed from. Keys match the `type`
// enum in contracts/screen-spec.schema.json. Every widget reads its binding
// from the spec and its values from the live snapshot; none of them decides
// layout, colour scheme or what to show -- that is the spec's and the
// renderer's job.

import type { ReactNode } from "react";
import {
  activeAlarmsOn,
  ago,
  alarmLimits,
  clamp,
  displayUnit,
  engineeringRange,
  findTag,
  formatNumber,
  formatValue,
  PRIORITY_COLOR,
  PRIORITY_RANK,
  quality,
  tagTitle,
} from "@/lib/format";
import { HISTORY_SAMPLES } from "@/lib/live";
import type { AlarmDef, AlarmPriority, ComponentType, MachineContext, SpecComponent, TagsSnapshot } from "@/lib/spec";
import { AlarmShape } from "./AlarmShape";

export interface WidgetProps {
  component: SpecComponent;
  context: MachineContext;
  snapshot: TagsSnapshot | undefined;
  history: Record<string, (number | null)[]>;
  assetNames: Record<string, string>;
  onNavigate?: (assetId: string) => void;
  onAck?: (alarmId: string) => void;
}

// ------------------------------------------------------------------ frame

function Cell({
  title,
  detail,
  alarm,
  bad,
  children,
}: {
  title: string;
  detail?: string;
  alarm?: AlarmPriority | null;
  bad?: boolean;
  children: ReactNode;
}) {
  const edge = alarm ? PRIORITY_COLOR[alarm] : bad ? "var(--bad-q)" : undefined;
  return (
    <section
      aria-label={title}
      className={`relative flex h-full min-w-0 flex-col border border-rule bg-well px-3.5 pb-3 pt-2.5 ${bad ? "bad-q" : ""}`}
      style={edge ? { borderColor: edge, boxShadow: `inset 4px 0 0 ${edge}` } : undefined}
    >
      <header className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold leading-tight text-ink">{title}</h3>
          {detail && <p className="truncate text-xs text-ink-faint">{detail}</p>}
        </div>
        {alarm && <AlarmShape priority={alarm} size={20} />}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {bad && (
        <p className="mt-1 text-xs font-semibold text-bad-q" role="status">
          Bad quality: last value held
        </p>
      )}
    </section>
  );
}

function worst(alarms: AlarmDef[]): AlarmPriority | null {
  return alarms[0]?.priority ?? null;
}

// --------------------------------------------- analog indicator (ISA-101)

/**
 * Moving-pointer analog indicator on the tag's engineering range, with the
 * normal operating band shaded and the alarm limits marked. Deviation reads
 * at a glance -- what a round dial makes you work out.
 */
function AnalogBar({
  value,
  min,
  max,
  limits,
  alarm,
  bad,
}: {
  value: number | null;
  min: number;
  max: number;
  limits: { value: number; alarm: AlarmDef }[];
  alarm: AlarmPriority | null;
  bad: boolean;
}) {
  // Plain HTML at a fixed height, so the indicator reads the same on a 7"
  // panel and a 15" one (an SVG scaled to the cell width would not).
  const span = max - min || 1;
  const pct = (v: number) => `${((clamp(v, min, max) - min) / span) * 100}%`;
  const lows = limits.filter((l) => l.alarm.condition.op.startsWith("<")).map((l) => l.value);
  const highs = limits.filter((l) => l.alarm.condition.op.startsWith(">")).map((l) => l.value);
  const bandFrom = lows.length ? Math.max(...lows) : min;
  const bandTo = highs.length ? Math.min(...highs) : max;
  const pointer = alarm ? PRIORITY_COLOR[alarm] : bad ? "var(--bad-q)" : "var(--ink)";
  return (
    <div aria-hidden className="mt-1">
      <div className="relative h-9">
        <div className="absolute inset-x-0 top-3 h-3 bg-chrome" />
        <div className="absolute top-3 h-3 bg-band" style={{ left: pct(bandFrom), width: `calc(${pct(bandTo)} - ${pct(bandFrom)})` }} />
        {limits.map((l) => (
          <div key={l.alarm.id} className="absolute top-1.5 h-6 w-0.5 -translate-x-1/2 bg-ink-2" style={{ left: pct(l.value) }} />
        ))}
        {value !== null && (
          <div className="absolute top-0 -translate-x-1/2 transition-[left] duration-500 ease-out motion-reduce:transition-none"
            style={{ left: pct(value) }}>
            <div className="mx-auto h-0 w-0 border-x-[7px] border-t-[10px] border-x-transparent" style={{ borderTopColor: pointer }} />
            <div className="mx-auto h-4 w-[3px]" style={{ background: pointer }} />
          </div>
        )}
      </div>
      <div className="flex justify-between text-[11px] text-ink-faint">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function Gauge({ component, context, snapshot }: WidgetProps) {
  const name = component.bind_tag ?? "";
  const tag = findTag(context, name);
  const range = engineeringRange(tag);
  const raw = snapshot?.tags[name];
  const value = typeof raw === "number" ? raw : null;
  const alarm = worst(activeAlarmsOn(context, snapshot, name));
  const bad = quality(snapshot, name) === "bad";
  const span = range.max - range.min;
  return (
    <Cell title={tagTitle(tag)} detail={tag.description ?? name} alarm={alarm} bad={bad}>
      <div className="flex flex-1 flex-col justify-center gap-1">
        <p className="cond flex items-baseline gap-1.5 leading-none">
          <span
            className="text-[44px] font-semibold"
            style={{ color: alarm ? "var(--ink)" : bad ? "var(--bad-q)" : "var(--ink)" }}
          >
            {formatValue(value, span)}
          </span>
          <span className="text-lg text-ink-2">{displayUnit(tag.unit)}</span>
          {alarm && (
            <span className="ml-2 text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {activeAlarmsOn(context, snapshot, name)[0]?.desc}
            </span>
          )}
        </p>
        <AnalogBar
          value={value}
          min={range.min}
          max={range.max}
          limits={alarmLimits(context, name)}
          alarm={alarm}
          bad={bad}
        />
        {range.assumed && <p className="text-xs text-ink-faint">No engineering range in the machine context; 0 to 100 shown.</p>}
      </div>
    </Cell>
  );
}

function NumericReadout({ component, context, snapshot }: WidgetProps) {
  const name = component.bind_tag ?? "";
  const tag = findTag(context, name);
  const range = engineeringRange(tag);
  const raw = snapshot?.tags[name];
  const alarm = worst(activeAlarmsOn(context, snapshot, name));
  const bad = quality(snapshot, name) === "bad";
  return (
    <Cell title={tagTitle(tag)} detail={tag.description} alarm={alarm} bad={bad}>
      <p className="cond mt-auto flex items-baseline gap-1.5 leading-none">
        <span className="text-[34px] font-semibold" style={{ color: bad ? "var(--bad-q)" : "var(--ink)" }}>
          {formatValue(typeof raw === "number" ? raw : null, range.max - range.min)}
        </span>
        <span className="text-base text-ink-2">{displayUnit(tag.unit)}</span>
      </p>
    </Cell>
  );
}

// ---------------------------------------------------------------- status

function stateWords(name: string): [string, string] {
  if (/RunStatus|Running|Fan_Status/i.test(name)) return ["Running", "Stopped"];
  if (/Health/i.test(name)) return ["Link up", "Link down"];
  return ["On", "Off"];
}

function StatusIndicator({ component, context, snapshot }: WidgetProps) {
  const name = component.bind_tag ?? "";
  const tag = findTag(context, name);
  const raw = snapshot?.tags[name];
  const alarm = worst(activeAlarmsOn(context, snapshot, name));
  const bad = quality(snapshot, name) === "bad";
  const [on, off] = stateWords(name);
  const label = typeof raw === "boolean" ? (raw ? on : off) : "--";
  // A link-health signal that is down is abnormal even with no alarm configured on it.
  const linkDown = /Health/i.test(name) && raw === false;
  const tone = bad || linkDown ? "var(--bad-q)" : "var(--ink)";
  return (
    <Cell title={tagTitle(tag)} detail={tag.description} alarm={alarm} bad={bad}>
      <div className="mt-auto flex items-center gap-3">
        <span
          aria-hidden
          className="size-5 shrink-0 border-2"
          style={{ borderColor: tone, background: raw === true ? "var(--process)" : "transparent" }}
        />
        <span className="cond text-[30px] font-semibold leading-none" style={{ color: tone }}>
          {label}
        </span>
      </div>
    </Cell>
  );
}

// ----------------------------------------------------------------- trends

const TW = 600;
const TH = 200;
const SERIES_STYLE = [
  { stroke: "var(--ink)", dash: undefined, width: 2.2 },
  { stroke: "var(--control)", dash: "8 5", width: 2 },
  { stroke: "var(--ink-2)", dash: "2 4", width: 2.4 },
  { stroke: "#8a6a3b", dash: "10 4 2 4", width: 2 },
];

function path(samples: (number | null)[], min: number, max: number): string {
  const span = max - min || 1;
  const step = TW / (HISTORY_SAMPLES - 1);
  const offset = HISTORY_SAMPLES - samples.length;
  let d = "";
  let pen = false;
  samples.forEach((v, i) => {
    if (v === null) {
      pen = false; // a gap where the data had bad quality, rather than a line through it
      return;
    }
    const x = (offset + i) * step;
    const y = TH - ((clamp(v, min, max) - min) / span) * TH;
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    pen = true;
  });
  return d;
}

function TrendPlot({
  series,
  min,
  max,
  limits,
  alarm,
}: {
  series: { name: string; samples: (number | null)[] }[];
  min: number;
  max: number;
  limits: { value: number }[];
  alarm: AlarmPriority | null;
}) {
  const span = max - min || 1;
  const y = (v: number) => TH - ((clamp(v, min, max) - min) / span) * TH;
  return (
    <div className="relative min-h-[110px] flex-1">
      <svg viewBox={`0 0 ${TW} ${TH}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
        <rect x={0} y={0} width={TW} height={TH} fill="var(--canvas)" />
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={TW} y1={TH * f} y2={TH * f} stroke="var(--chrome)" vectorEffect="non-scaling-stroke" />
        ))}
        {limits.map((l, i) => (
          <line key={i} x1={0} x2={TW} y1={y(l.value)} y2={y(l.value)} stroke="var(--ink-2)" strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s, i) => {
          const style = SERIES_STYLE[i % SERIES_STYLE.length];
          const stroke = i === 0 && alarm && series.length === 1 ? PRIORITY_COLOR[alarm] : style.stroke;
          return (
            <path key={s.name} d={path(s.samples, min, max)} fill="none" stroke={stroke} strokeWidth={style.width}
              strokeDasharray={style.dash} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          );
        })}
      </svg>
      <span className="absolute left-1 top-0.5 text-[11px] text-ink-faint">{max}</span>
      <span className="absolute bottom-0.5 left-1 text-[11px] text-ink-faint">{min}</span>
      <span className="absolute bottom-0.5 right-1 text-[11px] text-ink-faint">last 2 min</span>
    </div>
  );
}

function Trend({ component, context, snapshot, history }: WidgetProps) {
  const name = component.bind_tag ?? "";
  const tag = findTag(context, name);
  const range = engineeringRange(tag);
  const raw = snapshot?.tags[name];
  const alarm = worst(activeAlarmsOn(context, snapshot, name));
  const bad = quality(snapshot, name) === "bad";
  return (
    <Cell title={`${tagTitle(tag)} trend`} detail={tag.description} alarm={alarm} bad={bad}>
      <p className="cond mb-1 flex items-baseline gap-1.5 leading-none">
        <span className="text-[28px] font-semibold">{formatValue(typeof raw === "number" ? raw : null, range.max - range.min)}</span>
        <span className="text-sm text-ink-2">{displayUnit(tag.unit)}</span>
      </p>
      <TrendPlot series={[{ name, samples: history[name] ?? [] }]} min={range.min} max={range.max}
        limits={alarmLimits(context, name)} alarm={alarm} />
    </Cell>
  );
}

function MultiTrend({ component, context, snapshot, history }: WidgetProps) {
  const names = component.bind_tags ?? [];
  const tags = names.map((n) => findTag(context, n));
  const ranges = tags.map(engineeringRange);
  const min = Math.min(...ranges.map((r) => r.min));
  const max = Math.max(...ranges.map((r) => r.max));
  const alarms = names.flatMap((n) => activeAlarmsOn(context, snapshot, n)).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );
  const bad = names.some((n) => quality(snapshot, n) === "bad");
  const unit = displayUnit(tags[0]?.unit);
  return (
    <Cell title={`${tags.map((t) => tagTitle(t)).join(" vs ")}`} detail={`Compared on one axis, ${unit}`}
      alarm={worst(alarms)} bad={bad}>
      <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
        {tags.map((t, i) => {
          const v = snapshot?.tags[t.name];
          const style = SERIES_STYLE[i % SERIES_STYLE.length];
          return (
            <li key={t.name} className="flex items-center gap-1.5">
              <svg width="22" height="8" aria-hidden>
                <line x1="0" x2="22" y1="4" y2="4" stroke={style.stroke} strokeWidth={2.4} strokeDasharray={style.dash} />
              </svg>
              <span className="text-ink-2">{tagTitle(t)}</span>
              <span className="cond font-semibold">{formatValue(typeof v === "number" ? v : null, max - min)}</span>
            </li>
          );
        })}
      </ul>
      <TrendPlot series={names.map((n) => ({ name: n, samples: history[n] ?? [] }))} min={min} max={max}
        limits={[]} alarm={null} />
    </Cell>
  );
}

// ------------------------------------------------------------------ alarms

function AlarmBanner({ component, context, snapshot, onAck }: WidgetProps) {
  const defs = (component.bind_alarms ?? []).flatMap((id) => context.alarms.find((a) => a.id === id) ?? []);
  const states = snapshot?.alarm_states ?? {};
  const active = defs.filter((d) => states[d.id]?.active).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const quiet = defs.filter((d) => !states[d.id]?.active);
  const top = active[0]?.priority ?? null;
  return (
    <section
      aria-label="Alarms"
      aria-live="polite"
      className="border border-rule bg-well"
      style={top ? { borderColor: PRIORITY_COLOR[top], boxShadow: `inset 4px 0 0 ${PRIORITY_COLOR[top]}` } : undefined}
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-rule px-3.5 py-2">
        <h3 className="text-[15px] font-semibold">
          {snapshot === undefined
            ? "Waiting for live data"
            : active.length
              ? `${active.length} active alarm${active.length > 1 ? "s" : ""}`
              : "No active alarms"}
        </h3>
        <span className="text-xs text-ink-faint">watching {defs.length}</span>
      </header>
      <ul>
        {[...active, ...quiet].map((d) => {
          const s = states[d.id];
          const isActive = !!s?.active;
          const value = snapshot?.tags[d.tag];
          return (
            <li key={d.id} className={`flex items-center gap-3 px-3.5 py-1.5 ${isActive ? "" : "text-ink-faint"}`}>
              <AlarmShape priority={d.priority} active={isActive} acked={s?.acked} />
              <span className={`min-w-0 flex-1 truncate ${isActive ? "font-semibold text-ink" : ""}`}>{d.desc}</span>
              {isActive && (
                <span className="cond shrink-0 text-ink-2">
                  {typeof value === "number" ? formatNumber(value) : formatValue(value)} {displayUnit(findTag(context, d.tag).unit)}
                </span>
              )}
              <span className="w-12 shrink-0 text-right text-xs">{isActive ? ago(s?.since ?? null) : "Normal"}</span>
              {onAck && isActive && !s?.acked ? (
                <button type="button" onClick={() => onAck(d.id)}
                  className="shrink-0 border border-ink px-2 py-0.5 text-xs font-semibold hover:bg-chrome">
                  Acknowledge
                </button>
              ) : (
                isActive && <span className="w-[86px] shrink-0 text-right text-xs text-ink-2">Acknowledged</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------- comms

function CommsHealth({ component, context, snapshot }: WidgetProps) {
  const comm = context.comms.find((c) => c.device === component.bind_device);
  const raw = comm ? snapshot?.tags[comm.health_tag] : undefined;
  const down = raw === false;
  return (
    <Cell title={(comm?.device ?? component.bind_device ?? "").replaceAll("_", " ")} detail={comm?.protocol}>
      <div className="mt-auto flex items-center gap-3">
        <span aria-hidden className="size-5 shrink-0 border-2"
          style={{ borderColor: down ? "var(--bad-q)" : "var(--ink)", background: raw === true ? "var(--process)" : "transparent" }} />
        <span className="cond text-[28px] font-semibold leading-none" style={{ color: down ? "var(--bad-q)" : "var(--ink)" }}>
          {raw === undefined || raw === null ? "--" : down ? "Link down" : "Link up"}
        </span>
      </div>
      {comm && <p className="mt-1 truncate text-xs text-ink-faint">{comm.endpoint}</p>}
    </Cell>
  );
}

function NavTile({ component, assetNames, onNavigate }: WidgetProps) {
  const target = component.bind_asset ?? "";
  return (
    <Cell title={assetNames[target] ?? target} detail={target}>
      <button type="button" disabled={!onNavigate} onClick={() => onNavigate?.(target)}
        className="mt-auto self-start border border-ink px-3 py-1 text-sm font-semibold hover:bg-chrome disabled:opacity-40">
        Open machine
      </button>
    </Cell>
  );
}

// ---------------------------------------------------------------- registry

export interface RegistryEntry {
  label: string;
  Widget: (props: WidgetProps) => ReactNode;
  /** Size to content instead of a fixed cell height. */
  fit?: boolean;
  /** Minimum height in px when the cell is tall. */
  tall?: number;
}

export const REGISTRY: Record<ComponentType, RegistryEntry> = {
  alarm_banner: { label: "Alarm banner", Widget: AlarmBanner, fit: true },
  status_indicator: { label: "Status", Widget: StatusIndicator },
  gauge: { label: "Analog indicator", Widget: Gauge },
  numeric_readout: { label: "Readout", Widget: NumericReadout },
  trend: { label: "Trend", Widget: Trend, tall: 250 },
  multi_trend: { label: "Comparison trend", Widget: MultiTrend, tall: 270 },
  comms_health: { label: "Comms health", Widget: CommsHealth },
  nav_tile: { label: "Machine link", Widget: NavTile },
};

/** Why a component can't be drawn against this context, or null. Defence in depth: /api validated it already. */
export function bindingProblem(c: SpecComponent, context: MachineContext, knownAssets: string[]): string | null {
  const tags = new Set(context.tags.map((t) => t.name));
  switch (c.type) {
    case "alarm_banner": {
      const missing = (c.bind_alarms ?? []).filter((id) => !context.alarms.some((a) => a.id === id));
      return !c.bind_alarms ? "no alarms bound" : missing.length ? `${missing.join(", ")} not in ${context.context_version}` : null;
    }
    case "comms_health":
      return context.comms.some((d) => d.device === c.bind_device) ? null : `device ${c.bind_device} not in ${context.context_version}`;
    case "nav_tile":
      return knownAssets.includes(c.bind_asset ?? "") ? null : `machine ${c.bind_asset} is not known`;
    case "multi_trend": {
      const missing = (c.bind_tags ?? []).filter((t) => !tags.has(t));
      return missing.length ? `${missing.join(", ")} not in ${context.context_version}` : null;
    }
    default:
      return tags.has(c.bind_tag ?? "") ? null : `${c.bind_tag} not in ${context.context_version}`;
  }
}
