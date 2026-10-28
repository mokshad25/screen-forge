"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiUnreachableError, editStream, generateStream } from "@/lib/api";
import { clock, PRIORITY_RANK, tagTitle } from "@/lib/format";
import { PANEL_RULES } from "@/lib/layout";
import { LiveProvider, useAlarmEvents, useLive } from "@/lib/live";
import type {
  AlarmEvent,
  AlarmPriority,
  ApiError,
  AssetSummary,
  Health,
  MachineContext,
  PanelClass,
  ReconcileReport,
  SavedScreenSummary,
  ScreenSpec,
  SpecDiff,
} from "@/lib/spec";
import { AlarmPanel } from "./AlarmPanel";
import { AlarmShape } from "./AlarmShape";
import { applyStage, CommandBar, type StageMap } from "./CommandBar";
import { ActivityLog, AlarmToasts, ImportDialog, PlantControls, SpecPanel } from "./Panels";
import { PANEL_WIDTH, ScaleToFit, ScreenView } from "./ScreenView";

interface Screen {
  spec: ScreenSpec;
  /** What the operator typed to get it, for regenerating after a machine change. */
  request?: string;
  diff?: SpecDiff;
  changed?: Set<string>;
  saved?: boolean;
}

const ORIGIN_LABEL: Record<string, string> = {
  prompt: "Built from a request",
  regenerate: "Rebuilt after a machine change",
  edit: "Edited",
  alarm: "Alarm screen, built without the model",
  library: "From the library",
};

export function Console() {
  return (
    <LiveProvider>
      <ConsoleInner />
    </LiveProvider>
  );
}

function ConsoleInner() {
  const live = useLive();
  const [health, setHealth] = useState<Health | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [contexts, setContexts] = useState<Record<string, MachineContext>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [panel, setPanel] = useState<PanelClass>("large");
  const [compare, setCompare] = useState(false);
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [stages, setStages] = useState<StageMap>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [toasts, setToasts] = useState<AlarmEvent[]>([]);
  const [tab, setTab] = useState<"alarms" | "activity" | "spec">("alarms");
  const [library, setLibrary] = useState<SavedScreenSummary[]>([]);
  const [importing, setImporting] = useState(false);
  const [controls, setControls] = useState(false);
  const [stale, setStale] = useState<ReconcileReport | null>(null);
  const [logKey, setLogKey] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const names = useMemo(() => Object.fromEntries(assets.map((a) => [a.asset_id, a.name])), [assets]);

  // ------------------------------------------------------------- loading
  const loadAssets = useCallback(async () => {
    const list = await api.assets();
    setAssets(list);
    setSelected((s) => s ?? list[0]?.asset_id ?? null);
    return list;
  }, []);

  useEffect(() => {
    const ping = () =>
      api.health().then((h) => { setHealth(h); setApiDown(false); }).catch(() => setApiDown(true));
    ping();
    // Both set state only after a network round trip, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAssets().catch(() => setApiDown(true));
    api.screens().then(setLibrary).catch(() => {});
    const t = setInterval(ping, 5000);
    return () => clearInterval(t);
  }, [loadAssets]);

  // Keep every machine's context current: refetch when its live version moves on.
  useEffect(() => {
    for (const a of assets) {
      const snapVersion = live.snapshots[a.asset_id]?.context_version ?? a.context_version;
      if (contexts[a.asset_id]?.context_version === snapVersion) continue;
      api.context(a.asset_id).then((c) => setContexts((m) => ({ ...m, [c.asset_id]: c }))).catch(() => {});
    }
  }, [assets, live.tick, live.snapshots, contexts]);

  // Is the screen on show built for an older version of its machine?
  const screenAsset = screen?.spec.asset_id;
  const currentVersion = screenAsset ? contexts[screenAsset]?.context_version : undefined;
  useEffect(() => {
    if (!screen || !currentVersion || screen.spec.context_version === currentVersion) return;
    api.reconcile(screen.spec).then((r) => setStale("error" in r ? null : r)).catch(() => {});
  }, [screen, currentVersion]);

  // Only a report about the screen on show, against the machine as it is now, counts.
  const staleReport =
    stale && screen && stale.spec_context_version === screen.spec.context_version && stale.current_context_version === currentVersion
      ? stale
      : null;

  // ------------------------------------------------------------- alarms
  useAlarmEvents((e) => {
    if (e.event === "raised") setToasts((t) => [...t.filter((x) => !(x.asset_id === e.asset_id && x.alarm_id === e.alarm_id)), e]);
    else setToasts((t) => t.filter((x) => !(x.asset_id === e.asset_id && x.alarm_id === e.alarm_id)));
    setLogKey((k) => k + 1);
  });

  const ack = async (assetId: string, alarmId: string) => {
    await api.ack(assetId, alarmId).catch(() => {});
    setLogKey((k) => k + 1);
  };

  const openAlarmScreen = async (assetId: string, alarmId: string, ready?: ScreenSpec) => {
    const spec = ready ?? (await api.alarmScreen(assetId, alarmId).then((r) => ("spec" in r ? r.spec : null)).catch(() => null));
    if (!spec) return;
    setSelected(assetId);
    setScreen({ spec });
    setMode("new");
    setError(null);
    setStages({});
    setToasts((t) => t.filter((x) => !(x.asset_id === assetId && x.alarm_id === alarmId)));
  };

  // ------------------------------------------------------------- requests
  const run = async (text: string, opts?: { regenerate?: boolean }) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setStages({});
    const onStage = (e: Parameters<typeof applyStage>[1]) => setStages((m) => applyStage(m, e));
    try {
      const editing = mode === "edit" && screen && !opts?.regenerate;
      const result = editing
        ? await editStream({ instruction: text, spec: screen.spec, panel_class: panel }, onStage, controller.signal)
        : await generateStream(
            {
              prompt: text,
              asset_id: opts?.regenerate ? screen?.spec.asset_id ?? null : selected,
              panel_class: panel,
              since_context_version: opts?.regenerate ? screen?.spec.context_version : null,
              previous_spec: opts?.regenerate ? screen?.spec : null,
            },
            onStage,
            controller.signal,
          );
      if ("error" in result) {
        setError(result.error);
      } else {
        const changedIds = new Set(
          result.diff && screen
            ? result.spec.components
                .filter((c) => !screen.spec.components.some((o) => o.type === c.type && JSON.stringify(o) === JSON.stringify(c)))
                .map((c) => c.id)
            : [],
        );
        setScreen({ spec: result.spec, request: editing ? screen?.request : text, diff: result.diff, changed: changedIds });
        setSelected(result.spec.asset_id);
        if (editing && result.diff && !result.diff.unchanged) setTab("spec");
        setTimeout(() => setScreen((s) => (s ? { ...s, changed: undefined } : s)), 2500);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError({ message: e instanceof ApiUnreachableError ? e.message : `Unexpected error: ${(e as Error).message}`, stage: "request" });
      }
    } finally {
      setBusy(false);
      setLogKey((k) => k + 1);
    }
  };

  const updateStale = async () => {
    if (!screen) return;
    if (screen.spec.origin?.kind === "alarm" && screen.spec.origin.alarm_id) {
      await openAlarmScreen(screen.spec.asset_id, screen.spec.origin.alarm_id);
      return;
    }
    await run(screen.request ?? screen.spec.title, { regenerate: true });
  };

  const save = async () => {
    if (!screen) return;
    const r = await api.saveScreen(screen.spec).catch((e: Error) => ({ error: { message: e.message } }));
    if ("error" in r) { setError(r.error); return; }
    setScreen({ ...screen, saved: true });
    setLibrary(await api.screens());
    setLogKey((k) => k + 1);
  };

  const openSaved = async (id: string) => {
    const saved = await api.screen(id).catch(() => null);
    if (!saved) return;
    setScreen({ spec: { ...saved.spec }, saved: true });
    setSelected(saved.spec.asset_id);
    setError(null);
    setStages({});
  };

  /** Going to another machine leaves the current screen: it belongs to the machine it was built for. */
  const selectMachine = (assetId: string) => {
    setSelected(assetId);
    if (screen && screen.spec.asset_id !== assetId) {
      setScreen(null);
      setMode("new");
      setError(null);
      setStages({});
    }
  };

  const machineChange = async (action: "bump" | "reset") => {
    if (!selected) return;
    if (action === "bump") await api.bump(selected).catch(() => {});
    else await api.reset(selected).catch(() => {});
    await loadAssets();
    setLogKey((k) => k + 1);
  };

  // ------------------------------------------------------------- derived
  const context = selected ? contexts[selected] ?? null : null;
  const screenContext = screen ? contexts[screen.spec.asset_id] : undefined;
  const allStates = Object.values(live.snapshots).flatMap((s) => Object.values(s.alarm_states ?? {}).filter((a) => a.active));
  const counts = (["Critical", "High", "Warning"] as AlarmPriority[]).map((p) => ({
    p,
    n: allStates.filter((s) => s.priority === p).length,
    unacked: allStates.some((s) => s.priority === p && !s.acked),
  }));
  const suggestions = useMemo(() => {
    if (!context) return [];
    const first = context.alarms[0];
    const analog = context.tags.filter((t) => t.type === "analog");
    const out = [`${context.asset_hierarchy.at(-1)} overview`];
    if (first) out.push(`${first.desc.toLowerCase()} keeps coming back, what should I watch?`);
    if (analog.length >= 2) out.push(`compare ${tagTitle(analog[0]).toLowerCase()} and ${tagTitle(analog[1]).toLowerCase()}`);
    if (context.comms.length) out.push("are the comms links healthy?");
    return out;
  }, [context]);

  const liveMode = health?.tag_source.mode === "live";

  return (
    <div className="flex h-dvh flex-col">
      {/* ---------------------------------------------------------- top bar */}
      <header className="flex h-12 shrink-0 items-center gap-5 border-b border-ink bg-bezel px-4 text-chrome">
        <h1 className="cond text-[22px] font-semibold tracking-wide text-white">ScreenForge</h1>
        <p className="hidden truncate text-sm md:block">
          {screen && screenContext ? screenContext.asset_hierarchy.join(" / ") : context?.asset_hierarchy.join(" / ")}
        </p>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <span title={health?.tag_source.links.map((l) => `${l.device}: ${l.up ? "up" : l.error}`).join("\n")}>
            {apiDown ? (
              <span className="font-semibold text-alarm-3">API unreachable</span>
            ) : (
              <>
                Data: {liveMode ? "plant over OPC UA and Modbus" : "built-in simulator"}
                {liveMode && health?.tag_source.links.some((l) => !l.up) && (
                  <span className="ml-1.5 font-semibold text-[#c9b3ee]">
                    {health.tag_source.links.filter((l) => !l.up).length} link down
                  </span>
                )}
                {!live.connected && <span className="ml-1.5 text-chrome-2">(reconnecting)</span>}
              </>
            )}
          </span>
          <span className="flex items-center gap-2.5" aria-label="Active alarms by priority">
            {counts.map(({ p, n, unacked }) => (
              <span key={p} className="flex items-center gap-1" title={`${n} ${p.toLowerCase()}`}>
                <AlarmShape priority={p} active={n > 0} acked={!unacked} size={18} />
                <span className="cond w-4 text-base font-semibold text-white">{n}</span>
              </span>
            ))}
          </span>
          <Clock time={Math.max(0, ...Object.values(live.snapshots).map((x) => x.timestamp))} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------------ left rail */}
        <nav className="scroll-thin flex w-60 shrink-0 flex-col overflow-y-auto border-r border-rule bg-chrome" aria-label="Machines and screens">
          <h2 className="px-4 pb-1 pt-3 text-sm font-semibold text-ink-2">Machines</h2>
          <ul>
            {assets.map((a) => {
              const states = Object.values(live.snapshots[a.asset_id]?.alarm_states ?? {}).filter((s) => s.active)
                .sort((x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority]);
              const on = a.asset_id === selected;
              return (
                <li key={a.asset_id}>
                  <button type="button" onClick={() => selectMachine(a.asset_id)} aria-current={on}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left ${on ? "bg-canvas" : "hover:bg-chrome-2"}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{a.name}</span>
                      <span className="block truncate text-xs text-ink-2">
                        {a.hierarchy.slice(1, -1).join(" / ")}{a.origin.startsWith("opcua") ? ", from OPC UA" : ""}
                      </span>
                    </span>
                    {states[0] && <AlarmShape priority={states[0].priority} acked={states.every((s) => s.acked)} size={18} />}
                    {states.length > 1 && <span className="cond text-sm">{states.length}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={() => setImporting(true)}
            className="mx-4 mt-2 border border-dashed border-ink-2 px-2 py-1.5 text-sm font-semibold hover:bg-chrome-2">
            Add a machine from OPC UA
          </button>

          <h2 className="mt-5 px-4 pb-1 text-sm font-semibold text-ink-2">Saved screens</h2>
          {library.length === 0 ? (
            <p className="px-4 text-xs text-ink-2">Save a screen to keep it here.</p>
          ) : (
            <ul>
              {library.map((s) => (
                <li key={s.screen_id} className="group flex items-center">
                  <button type="button" onClick={() => openSaved(s.screen_id)}
                    className={`min-w-0 flex-1 px-4 py-1.5 text-left hover:bg-chrome-2 ${screen?.spec.screen_id === s.screen_id ? "bg-canvas" : ""}`}>
                    <span className="block truncate text-sm">{s.title}</span>
                    <span className="block truncate text-xs text-ink-2">{names[s.asset_id] ?? s.asset_id}</span>
                  </button>
                  <button type="button" aria-label={`Remove ${s.title}`}
                    onClick={async () => { await api.deleteScreen(s.screen_id); setLibrary(await api.screens()); }}
                    className="px-2 text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100 focus:opacity-100">✕</button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-auto border-t border-rule p-3">
            <button type="button" onClick={() => setControls((c) => !c)} aria-expanded={controls}
              className="w-full border border-ink-2 px-2 py-1.5 text-sm font-semibold hover:bg-chrome-2">
              {controls ? "Hide plant controls" : "Plant controls"}
            </button>
          </div>
        </nav>

        {/* ---------------------------------------------------------- stage */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-chrome px-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {screen ? ORIGIN_LABEL[screen.spec.origin?.kind ?? "prompt"] : "No screen yet"}
                {screen?.spec.origin?.instruction && <span className="font-normal text-ink-2">: &ldquo;{screen.spec.origin.instruction}&rdquo;</span>}
              </p>
              {screen && <p className="text-xs text-ink-2">Built for {screen.spec.context_version}, {screen.spec.components.length} components</p>}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div role="radiogroup" aria-label="Panel size" className="flex border border-ink-2">
                {(["small", "medium", "large"] as PanelClass[]).map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={!compare && panel === p}
                    onClick={() => { setPanel(p); setCompare(false); }}
                    className={`px-2.5 py-1 text-sm font-semibold ${!compare && panel === p ? "bg-ink text-chrome" : "hover:bg-chrome-2"}`}>
                    {PANEL_RULES[p].diagonal}
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={compare} onClick={() => setCompare(true)}
                  className={`border-l border-ink-2 px-2.5 py-1 text-sm font-semibold ${compare ? "bg-ink text-chrome" : "hover:bg-chrome-2"}`}>
                  All three
                </button>
              </div>
              {screen && (
                <button type="button" onClick={() => { setScreen(null); setMode("new"); setStages({}); setError(null); }}
                  className="border border-ink-2 px-2.5 py-1 text-sm font-semibold hover:bg-chrome-2">
                  Close screen
                </button>
              )}
              {screen && (
                <button type="button" onClick={save} disabled={screen.saved}
                  className="border border-ink-2 px-2.5 py-1 text-sm font-semibold hover:bg-chrome-2 disabled:opacity-50">
                  {screen.saved ? "Saved" : "Save screen"}
                </button>
              )}
            </div>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-chrome-2/40 p-4">
            {staleReport && screen && (
              <div className="mb-3 flex flex-wrap items-center gap-3 border border-ink bg-well px-3 py-2 text-sm" role="status">
                <p className="min-w-0 flex-1">
                  <strong>This machine changed</strong> since the screen was built ({staleReport.spec_context_version} to {staleReport.current_context_version}).
                  {staleReport.changes?.tags_added.length ? ` New: ${staleReport.changes.tags_added.map((t) => tagTitle(t)).join(", ")}.` : ""}
                  {staleReport.broken_bindings.length ? ` ${staleReport.broken_bindings.length} binding(s) no longer exist.` : ""}
                </p>
                <button type="button" onClick={updateStale} disabled={busy || (!health?.llm.configured && screen.spec.origin?.kind !== "alarm")}
                  className="bg-control px-3 py-1 font-semibold text-white disabled:opacity-40">Update screen</button>
              </div>
            )}
            {error && (
              <div role="alert" className={`mb-3 border bg-well px-3 py-2 text-sm ${error.stage === "read_only" ? "border-ink" : "border-alarm-1"}`}
                style={{ boxShadow: `inset 4px 0 0 ${error.stage === "read_only" ? "var(--ink)" : "var(--alarm-1)"}` }}>
                <p className="font-semibold">
                  {error.stage === "read_only" ? "Read-only by design" :
                    error.stage === "intent" ? "Which machine?" : `That screen could not be built${error.stage ? ` (stopped at ${error.stage})` : ""}`}
                </p>
                <p className="mt-0.5 text-ink-2">{error.message}</p>
              </div>
            )}
            {screen && screenContext ? (
              compare ? (
                <div className="flex flex-wrap items-start gap-4">
                  {(["small", "medium", "large"] as PanelClass[]).map((p) => (
                    <div key={p} className="min-w-[280px]" style={{ flex: `${PANEL_WIDTH[p]} 1 0` }}>
                      <ScaleToFit width={PANEL_WIDTH[p]}>
                        <ScreenView spec={screen.spec} context={screenContext} panel={p} snapshot={live.snapshots[screen.spec.asset_id]}
                          history={live.history[screen.spec.asset_id] ?? {}} assetNames={names} />
                      </ScaleToFit>
                    </div>
                  ))}
                </div>
              ) : (
                <ScaleToFit width={PANEL_WIDTH[panel]}>
                  <ScreenView spec={screen.spec} context={screenContext} panel={panel} snapshot={live.snapshots[screen.spec.asset_id]}
                    history={live.history[screen.spec.asset_id] ?? {}} assetNames={names} changed={screen.changed}
                    onNavigate={selectMachine} onAck={(id) => ack(screen.spec.asset_id, id)} />
                </ScaleToFit>
              )
            ) : (
              <EmptyStage context={context} snapshotAlarms={selected ? live.snapshots[selected]?.alarm_states : undefined}
                onAlarmScreen={(id) => selected && openAlarmScreen(selected, id)} />
            )}
          </div>

          <CommandBar mode={mode} canEdit={!!screen} onMode={setMode} busy={busy} stages={stages}
            llmReady={!!health?.llm.configured} suggestions={suggestions}
            onSubmit={(t) => run(t)} onCancel={() => { abort.current?.abort(); setBusy(false); setStages({}); }} />
          {controls && (
            <PlantControls health={health} context={context} onMachineChange={machineChange} onClose={() => setControls(false)} />
          )}
        </main>

        {/* ---------------------------------------------------------- right */}
        <aside className="hidden w-[340px] shrink-0 flex-col border-l border-rule bg-well lg:flex" aria-label="Alarms and details">
          <div role="tablist" className="flex border-b border-rule">
            {([["alarms", `Alarms${allStates.length ? ` (${allStates.length})` : ""}`], ["activity", "Activity"], ["spec", "Spec"]] as const).map(([key, label]) => (
              <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`flex-1 px-3 py-2 text-sm font-semibold ${tab === key ? "border-b-2 border-ink" : "text-ink-2 hover:text-ink"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {tab === "alarms" && (
              <AlarmPanel contexts={contexts} snapshots={live.snapshots} assetNames={names} onAck={ack}
                onOpenScreen={(a, id) => openAlarmScreen(a, id)} />
            )}
            {tab === "activity" && <ActivityLog names={names} refreshKey={logKey} />}
            {tab === "spec" && <SpecPanel spec={screen?.spec ?? null} diff={screen?.diff ?? null} />}
          </div>
        </aside>
      </div>

      <AlarmToasts events={toasts} names={names} onOpen={(e) => openAlarmScreen(e.asset_id, e.alarm_id, e.screen)}
        onDismiss={(e) => setToasts((t) => t.filter((x) => x !== e))} />
      {importing && (
        <ImportDialog onClose={() => setImporting(false)}
          onImported={async (id) => { await loadAssets(); setSelected(id); setLogKey((k) => k + 1); }} />
      )}
    </div>
  );
}

function EmptyStage({
  context,
  snapshotAlarms,
  onAlarmScreen,
}: {
  context: MachineContext | null;
  snapshotAlarms: Record<string, { active: boolean }> | undefined;
  onAlarmScreen: (alarmId: string) => void;
}) {
  if (!context) return <p className="p-8 text-ink-2">Connecting to the ScreenForge API.</p>;
  return (
    <div className="mx-auto max-w-2xl bg-canvas p-8">
      <p className="text-sm text-ink-2">{context.asset_hierarchy.join(" / ")}</p>
      <h2 className="cond mt-1 text-4xl font-semibold">Ask for the screen you need</h2>
      <p className="mt-2 max-w-prose text-ink-2">
        Describe what you want to watch on {context.asset_hierarchy.at(-1)} below, by typing or speaking. ScreenForge only uses this
        machine&apos;s {context.tags.filter((t) => t.access === "read").length} readable signals and never changes anything on it.
      </p>
      {context.alarms.length > 0 && (
        <>
          <h3 className="mt-6 font-semibold">Or open an alarm screen</h3>
          <p className="text-sm text-ink-2">Built instantly from the alarm&apos;s playbook, without the model.</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {context.alarms.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => onAlarmScreen(a.id)}
                  className="flex items-center gap-2 border border-rule bg-well px-2.5 py-1.5 text-sm hover:border-ink">
                  <AlarmShape priority={a.priority} active={!!snapshotAlarms?.[a.id]?.active} size={16} decorative />
                  {a.desc}
                  <span className="sr-only">, {a.priority.toLowerCase()} priority</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Time of the latest plant reading: if data stops arriving, the clock stops too. */
function Clock({ time }: { time: number }) {
  return <span className="cond w-[70px] text-right text-base">{time ? clock(time) : "--:--:--"}</span>;
}
