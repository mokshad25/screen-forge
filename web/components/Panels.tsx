"use client";

// Smaller pieces of the console: activity log, spec inspector, alarm toasts,
// import dialog, plant controls.

import { useEffect, useState } from "react";
import { api, plant } from "@/lib/api";
import { clock, tagTitle } from "@/lib/format";
import type { AlarmEvent, ApiError, Health, LogEntry, MachineContext, ReconcileReport, ScreenSpec, SpecDiff } from "@/lib/spec";
import { AlarmShape } from "./AlarmShape";

// ---------------------------------------------------------------- activity

function describe(e: LogEntry, names: Record<string, string>): string {
  const machine = e.asset_id ? names[e.asset_id] ?? e.asset_id : "";
  const d = e as Record<string, unknown>;
  switch (e.kind) {
    case "alarm_raised": return `${d.desc} raised on ${machine}`;
    case "alarm_cleared": return `${d.desc} cleared on ${machine}`;
    case "alarm_acked": return `${d.alarm_id} acknowledged on ${machine}`;
    case "generate": return d.ok ? `Screen built for "${d.request}" in ${d.seconds} s` : `Request "${d.request}" refused at ${d.error_stage}`;
    case "edit": return d.ok ? `Edited: "${d.request}"` : `Edit "${d.request}" refused at ${d.error_stage}`;
    case "screen_saved": return `Saved "${d.title}" to the library`;
    case "screen_deleted": return `Removed a screen from the library`;
    case "context_changed": return `${machine} changed: now ${d.version}`;
    case "context_reset": return `${machine} reset to ${d.version}`;
    case "context_imported": return `Imported ${machine} over OPC UA (${d.tags} tags)`;
    default: return e.kind;
  }
}

export function ActivityLog({ names, refreshKey }: { names: Record<string, string>; refreshKey: number }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.log(80).then((l) => alive && setEntries(l)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [refreshKey]);
  if (!entries) return <p className="px-4 py-6 text-sm text-ink-2">Loading the log.</p>;
  if (!entries.length) return <p className="px-4 py-6 text-sm text-ink-2">Nothing has happened yet.</p>;
  return (
    <ol className="divide-y divide-rule text-sm">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-3 px-4 py-1.5">
          <span className="cond w-16 shrink-0 text-ink-2">{clock(e.ts)}</span>
          <span className="min-w-0">{describe(e, names)}</span>
        </li>
      ))}
    </ol>
  );
}

// -------------------------------------------------------------------- spec

export function SpecPanel({ spec, diff }: { spec: ScreenSpec | null; diff: SpecDiff | null }) {
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<ReconcileReport | ApiError | string | null>(null);
  const check = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setReport("That is not valid JSON.");
      return;
    }
    const r = await api.reconcile(parsed).catch((e: Error) => e.message);
    setReport(typeof r === "string" ? r : "error" in r ? r.error : r);
  };
  return (
    <div className="space-y-4 px-4 py-3 text-sm">
      {diff && !diff.unchanged && (
        <section>
          <h3 className="font-semibold">What the last edit changed</h3>
          <ul className="mt-1 list-disc pl-5 text-ink-2">
            {diff.summary.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </section>
      )}
      <section>
        <h3 className="font-semibold">The spec behind this screen</h3>
        <p className="text-xs text-ink-2">This is everything the model wrote. Layout, colour and values come from the renderer and the plant.</p>
        <pre className="scroll-thin mt-1 max-h-72 overflow-auto border border-rule bg-well p-2 text-[11px] leading-snug">
          {spec ? JSON.stringify(spec, null, 2) : "No screen yet."}
        </pre>
      </section>
      <section>
        <h3 className="font-semibold">Check any spec</h3>
        <p className="text-xs text-ink-2">Paste JSON. The API&apos;s validator judges it; nothing is repaired.</p>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label="Spec to check"
          className="mt-1 w-full border border-rule bg-well p-2 text-[11px]" />
        <button type="button" onClick={check} disabled={!draft.trim()}
          className="mt-1 border border-ink-2 px-2.5 py-1 text-xs font-semibold hover:bg-chrome disabled:opacity-40">
          Validate
        </button>
        {report && (
          <div className="mt-2 border border-rule bg-well p-2 text-xs">
            {typeof report === "string" ? report :
              "message" in report ? <p><strong>Rejected at {report.stage}:</strong> {report.message}</p> :
              report.still_valid ? <p><strong>Valid</strong> against {report.current_context_version}{report.stale ? `, built for ${report.spec_context_version}` : ""}.</p> :
              <><p><strong>Invalid.</strong></p><ul className="list-disc pl-4">{report.errors.map((e) => <li key={e}>{e}</li>)}</ul></>}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------ alarm toasts

export function AlarmToasts({
  events,
  names,
  onOpen,
  onDismiss,
}: {
  events: AlarmEvent[];
  names: Record<string, string>;
  onOpen: (e: AlarmEvent) => void;
  onDismiss: (e: AlarmEvent) => void;
}) {
  if (!events.length) return null;
  return (
    <div className="pointer-events-none fixed right-2.5 top-14 z-40 flex w-[320px] flex-col gap-2" aria-live="assertive">
      {events.slice(-2).reverse().map((e) => (
        <div key={`${e.asset_id}/${e.alarm_id}/${e.ts}`}
          className="sf-arrive pointer-events-auto border border-ink bg-well p-3 shadow-[4px_4px_0_var(--ink)]">
          <div className="flex items-start gap-2.5">
            <AlarmShape priority={e.priority} size={22} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold leading-tight">{e.desc}</p>
              <p className="text-xs text-ink-2">{names[e.asset_id] ?? e.asset_id}, {e.priority.toLowerCase()} priority, {clock(e.ts)}</p>
              {e.screen && <p className="mt-1 text-xs">A troubleshooting screen is ready.</p>}
            </div>
          </div>
          <div className="mt-2 flex gap-2 pl-8">
            {e.screen && (
              <button type="button" onClick={() => onOpen(e)}
                className="bg-control px-2.5 py-1 text-xs font-semibold text-white hover:brightness-110">
                Open alarm screen
              </button>
            )}
            <button type="button" onClick={() => onDismiss(e)} className="border border-ink-2 px-2.5 py-1 text-xs font-semibold hover:bg-chrome">
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ import dialog

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (assetId: string) => void }) {
  const [endpoint, setEndpoint] = useState("opc.tcp://127.0.0.1:4840/screenforge");
  const [found, setFound] = useState<{ asset_id: string; name: string; known: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const browse = async () => {
    setBusy(true); setMessage(null); setFound(null);
    try {
      const r = await api.importBrowse(endpoint);
      if ("error" in r) setMessage(r.error.message); else setFound(r.assets);
    } catch (e) { setMessage((e as Error).message); }
    setBusy(false);
  };
  const take = async (assetId: string) => {
    setBusy(true); setMessage(null);
    try {
      const r = await api.importAsset(endpoint, assetId);
      if ("error" in r) setMessage(r.error.message);
      else { onImported(assetId); onClose(); }
    } catch (e) { setMessage((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="w-full max-w-lg border border-ink bg-well p-5 shadow-[6px_6px_0_var(--ink)]">
        <h2 id="import-title" className="cond text-2xl font-semibold">Add a machine from OPC UA</h2>
        <p className="mt-1 text-sm text-ink-2">
          ScreenForge browses the server and builds the machine&apos;s context from it: tags, units, engineering ranges and alarms.
          It only reads. Servers must be on the API&apos;s allowlist.
        </p>
        <label className="mt-4 block text-sm font-semibold" htmlFor="endpoint">Server endpoint</label>
        <div className="mt-1 flex gap-2">
          <input id="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
            className="flex-1 border border-ink-2 bg-canvas px-2 py-1.5 text-sm" />
          <button type="button" onClick={browse} disabled={busy} className="bg-control px-3 text-sm font-semibold text-white disabled:opacity-50">
            Browse
          </button>
        </div>
        {found && (
          <ul className="mt-4 divide-y divide-rule border border-rule">
            {found.length === 0 && <li className="p-2 text-sm text-ink-2">The server exposes no machines.</li>}
            {found.map((a) => (
              <li key={a.asset_id} className="flex items-center justify-between gap-3 p-2 text-sm">
                <span><strong>{a.name}</strong> <span className="text-ink-2">{a.asset_id}</span></span>
                {a.known ? <span className="text-xs text-ink-2">Already added</span> : (
                  <button type="button" onClick={() => take(a.asset_id)} disabled={busy}
                    className="border border-ink px-2 py-0.5 text-xs font-semibold hover:bg-chrome">Add machine</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {message && <p className="mt-3 border-l-4 border-alarm-1 pl-2 text-sm">{message}</p>}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="border border-ink-2 px-3 py-1 text-sm font-semibold hover:bg-chrome">Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- plant controls

/**
 * Demo controls. They act on the PLANT -- the built-in simulator, or the
 * separate plant_sim process -- never through ScreenForge's read path.
 */
export function PlantControls({
  health,
  context,
  onMachineChange,
  onClose,
}: {
  health: Health | null;
  context: MachineContext | null;
  onMachineChange: (action: "bump" | "reset") => void;
  onClose: () => void;
}) {
  const live = health?.tag_source.mode === "live";
  const analog = context?.tags.filter((t) => t.type === "analog" && t.access === "read") ?? [];
  const [tag, setTag] = useState(analog[0]?.name ?? "");
  const [note, setNote] = useState<string | null>(null);
  const tagDef = context?.tags.find((t) => t.name === tag);
  const limit = context?.alarms.find((a) => a.tag === tag && typeof a.condition.value === "number");
  const tripValue = limit
    ? (limit.condition.op.startsWith(">") ? (limit.condition.value as number) * 1.15 : (limit.condition.value as number) * 0.7)
    : tagDef?.range?.high ?? 0;

  const fault = async () => {
    if (!context || !tag) return;
    setNote(null);
    try {
      if (live) await plant.fault(tag, Number(tripValue.toFixed(2)), 25);
      else {
        const r = await api.simFault(context.asset_id, tag, Number(tripValue.toFixed(2)), 25);
        if (r.error) throw new Error(r.error.message);
      }
      setNote(`${tagTitle(tag)} held at ${tripValue.toFixed(1)} for 25 s.`);
    } catch (e) { setNote((e as Error).message); }
  };
  const link = async (device: string, up: boolean) => {
    try { await plant.link(device, up); setNote(`${device} link ${up ? "restored" : "pulled"}.`); }
    catch (e) { setNote(`Plant control unreachable: ${(e as Error).message}`); }
  };

  return (
    <section className="border-t border-ink bg-well px-4 py-3" aria-label="Plant controls">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Plant controls <span className="font-normal text-ink-2">for demos; these act on the simulated plant, not through ScreenForge</span></h2>
        <button type="button" onClick={onClose} className="text-sm font-semibold text-control hover:underline">Hide</button>
      </div>
      {!context ? <p className="mt-2 text-sm text-ink-2">Pick a machine first.</p> : (
        <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
          <div>
            <label htmlFor="fault-tag" className="block text-xs text-ink-2">Push a signal past its alarm limit</label>
            <div className="mt-0.5 flex gap-1.5">
              <select id="fault-tag" value={tag} onChange={(e) => setTag(e.target.value)} className="border border-ink-2 bg-canvas px-1.5 py-1">
                {analog.map((t) => <option key={t.name} value={t.name}>{tagTitle(t)}</option>)}
              </select>
              <button type="button" onClick={fault} className="border border-ink bg-canvas px-2.5 font-semibold hover:bg-chrome">Inject fault</button>
            </div>
          </div>
          <div>
            <p className="text-xs text-ink-2">Fit a vibration sensor to this machine</p>
            <div className="mt-0.5 flex gap-1.5">
              <button type="button" onClick={() => onMachineChange("bump")} className="border border-ink bg-canvas px-2.5 py-1 font-semibold hover:bg-chrome">Change machine</button>
              <button type="button" onClick={() => onMachineChange("reset")} className="border border-ink-2 bg-canvas px-2.5 py-1 hover:bg-chrome">Reset</button>
            </div>
          </div>
          {live && (
            <div>
              <p className="text-xs text-ink-2">Pull a network link</p>
              <div className="mt-0.5 flex gap-1.5">
                {context.comms.filter((c) => c.endpoint.startsWith("modbus")).map((c) => (
                  <span key={c.device} className="flex">
                    <button type="button" onClick={() => link(c.device, false)} className="border border-ink bg-canvas px-2 py-1 font-semibold hover:bg-chrome">Pull {c.device}</button>
                    <button type="button" onClick={() => link(c.device, true)} className="border border-l-0 border-ink-2 bg-canvas px-2 py-1 hover:bg-chrome">Restore</button>
                  </span>
                ))}
                {!context.comms.some((c) => c.endpoint.startsWith("modbus")) && <span className="text-ink-2">No Modbus links on this machine.</span>}
              </div>
            </div>
          )}
          {note && <p className="basis-full text-ink-2">{note}</p>}
        </div>
      )}
    </section>
  );
}
