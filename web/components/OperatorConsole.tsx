"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, ApiUnreachableError, generateScreen, reconcileScreen } from "@/lib/api";
import { FIXTURE_ASSETS, GOLDEN_SPECS } from "@/lib/contracts";
import { PANEL_CLASSES, PANEL_RULES } from "@/lib/layout";
import type { PanelClass, ReconcileReport, ScreenSpec, SpecComponent } from "@/lib/spec";
import { useLiveTags, type TagSource } from "@/lib/useLiveTags";
import { useMachineContext } from "@/lib/useMachineContext";
import { useSpeechRecognition } from "@/lib/useSpeechRecognition";
import { ContextUpdateBanner } from "./ContextUpdateBanner";
import { ErrorCard, type ConsoleError } from "./ErrorCard";
import { PANEL_NOMINAL_WIDTH, PanelFrame } from "./PanelFrame";
import {
  IDLE_PROGRESS,
  ProgressStages,
  STAGE_OF_ERROR,
  STAGES,
  type GenerationProgress,
} from "./ProgressStages";
import { ScaleToFit } from "./ScaleToFit";
import { ScreenRenderer } from "./ScreenRenderer";
import { SpecValidator } from "./SpecValidator";
import { VoiceButton } from "./VoiceButton";

const EXAMPLE_PROMPTS = [
  "Show conveyor A motor status and active alarms",
  "Trend the chiller supply water temperature",
  "Connectivity health for the chiller",
  "Let me start the conveyor motor",
];

type ViewMode = "single" | "side-by-side";

type Origin =
  | { kind: "golden"; key: string; path: string; fallback: boolean }
  | { kind: "generated"; prompt: string; elapsedMs: number; contextUpdate: ReconcileReport | null };

interface GenerateOptions {
  /** Text to send instead of what is in the request box (voice, regeneration). */
  text?: string;
  /** Asset to send instead of the machine picker's choice. */
  assetId?: string | null;
  /** Set when this generation answers a context change, so the result can say so. */
  contextUpdate?: ReconcileReport | null;
  /** The context_version the replaced screen was built for; /api then tells the model what's new. */
  sinceContextVersion?: string;
  /** The screen being replaced; /api keeps its components and adds the new signal alongside. */
  previousSpec?: ScreenSpec;
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex items-center gap-2 ${disabled ? "opacity-40" : ""}`}>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
      <div className="flex rounded-lg border border-cell-border bg-bg p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              value === option.value ? "bg-neutral-fill text-bezel" : "text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ tags, mismatch }: { tags: TagSource; mismatch: boolean }) {
  const live = tags === "api";
  let text = "Mock tags · API offline";
  if (tags === "connecting") text = "Connecting…";
  else if (live) text = "Live tags from API";
  else if (mismatch) text = "Mock tags · API /tags not understood";
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-cell-border px-3 py-1 text-xs font-semibold text-muted">
      <span className={`size-2 rounded-full ${live ? "bg-neutral-fill" : "border border-faint"}`} aria-hidden />
      {text}
    </span>
  );
}

interface OperatorConsoleProps {
  initialGolden?: string;
  initialPanel?: string;
  initialView?: string;
}

export function OperatorConsole({ initialGolden, initialPanel, initialView }: OperatorConsoleProps) {
  const firstGolden = GOLDEN_SPECS.find((g) => g.key === initialGolden) ?? GOLDEN_SPECS[0];
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState("auto");
  const [panel, setPanel] = useState<PanelClass>(PANEL_CLASSES.find((p) => p === initialPanel) ?? "medium");
  const [view, setView] = useState<ViewMode>(initialView === "side-by-side" ? "side-by-side" : "single");
  const [spec, setSpec] = useState<ScreenSpec>(firstGolden.spec);
  const [origin, setOrigin] = useState<Origin>({
    kind: "golden",
    key: firstGolden.key,
    path: firstGolden.path,
    fallback: firstGolden.fallback,
  });
  const [progress, setProgress] = useState<GenerationProgress>(IDLE_PROGRESS);
  const [error, setError] = useState<ConsoleError | null>(null);
  const runId = useRef(0);

  // The context comes from GET /context when /api is up, else from the frozen fixtures.
  const { context, refresh: refreshContext } = useMachineContext(spec.asset_id);
  const { live, source: tagSource, problem: tagsProblem } = useLiveTags(context);
  const running = progress.status === "running";

  // /tags reports the context_version the API is running now. When it moves, load that context.
  const liveVersion = live.snapshot?.context_version ?? null;
  useEffect(() => {
    if (context && liveVersion && liveVersion !== context.context_version) refreshContext();
  }, [context, liveVersion, refreshContext]);

  const generate = useCallback(
    async (options: GenerateOptions = {}) => {
      const text = (options.text ?? prompt).trim();
      if (!text) return;
      const id = ++runId.current;
      const started = performance.now();
      setError(null);
      setProgress({ status: "running", active: 0, failed: null, elapsedMs: null });

      // /generate is one request, so the first stages advance on a timer while it runs.
      const advance = (stage: number) =>
        setProgress((p) => (id === runId.current && p.status === "running" && p.active < stage ? { ...p, active: stage } : p));
      const timers = [window.setTimeout(() => advance(1), 700), window.setTimeout(() => advance(2), 1500)];

      try {
        const result = await generateScreen({
          prompt: text,
          asset_id: options.assetId !== undefined ? options.assetId : target === "auto" ? null : target,
          panel_class: panel,
          since_context_version: options.sinceContextVersion ?? null,
          previous_spec: options.previousSpec ?? null,
        });
        if (id !== runId.current) return;

        if ("error" in result) {
          const stage = result.error.stage;
          const failed = (stage !== undefined ? STAGE_OF_ERROR[stage] : undefined) ?? STAGES.length - 1;
          setProgress({ status: "failed", active: failed, failed, elapsedMs: performance.now() - started });
          setError({ kind: "api", error: result.error });
          return;
        }

        advance(3);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        if (id !== runId.current) return;
        const elapsedMs = performance.now() - started;
        setSpec(result.spec);
        setOrigin({ kind: "generated", prompt: text, elapsedMs, contextUpdate: options.contextUpdate ?? null });
        setProgress({ status: "done", active: STAGES.length, failed: null, elapsedMs });
      } catch (e) {
        if (id !== runId.current) return;
        setProgress(IDLE_PROGRESS);
        setError(
          e instanceof ApiUnreachableError
            ? { kind: "unreachable", message: e.message }
            : { kind: "client", message: e instanceof Error ? e.message : String(e) },
        );
      } finally {
        timers.forEach((t) => window.clearTimeout(t));
      }
    },
    [prompt, target, panel],
  );

  // A screen built against an older context: ask /api what changed and which bindings broke.
  const staleKey =
    context && context.context_version !== spec.context_version
      ? `${spec.screen_id}|${spec.context_version}|${context.context_version}`
      : null;
  const [reconciled, setReconciled] = useState<{ key: string; report: ReconcileReport | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!staleKey) return;
    let cancelled = false;
    reconcileScreen(spec).then(
      (report) => {
        if (!cancelled) setReconciled({ key: staleKey, report, failed: false });
      },
      () => {
        if (!cancelled) setReconciled({ key: staleKey, report: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [staleKey, spec]);
  const reconcile = reconciled && reconciled.key === staleKey ? reconciled : null;

  // A generated screen follows its machine automatically; a golden screen waits for the operator.
  const autoRegenerated = useRef<string | null>(null);
  useEffect(() => {
    if (!staleKey || !reconcile || origin.kind !== "generated" || running) return;
    if (autoRegenerated.current === staleKey) return;
    autoRegenerated.current = staleKey;
    void generate({
      text: origin.prompt,
      assetId: spec.asset_id,
      contextUpdate: reconcile.report,
      sinceContextVersion: spec.context_version,
      previousSpec: spec,
    });
  }, [staleKey, reconcile, origin, running, generate, spec]);

  const regenerateForContext = () => {
    const text = origin.kind === "generated" ? origin.prompt : spec.title;
    setPrompt(text);
    void generate({
      text,
      assetId: spec.asset_id,
      contextUpdate: reconcile?.report ?? null,
      sinceContextVersion: spec.context_version,
      previousSpec: spec,
    });
  };

  // Voice: the transcript fills the request box as it is heard; a final result generates straight away.
  const voice = useSpeechRecognition((text, isFinal) => {
    setPrompt(text);
    if (isFinal && text) void generate({ text });
  });

  const loadGolden = (key: string) => {
    const golden = GOLDEN_SPECS.find((g) => g.key === key);
    if (!golden) return;
    runId.current += 1; // abandon any in-flight generation
    setSpec(golden.spec);
    setOrigin({ kind: "golden", key: golden.key, path: golden.path, fallback: golden.fallback });
    setProgress(IDLE_PROGRESS);
    setError(null);
  };

  // Drill-down from a nav_tile: point the request at that asset; the operator decides what to ask.
  const navigateTo = (component: SpecComponent) => {
    const asset = FIXTURE_ASSETS.find((a) => a.asset_id === component.bind_asset);
    if (!asset) return;
    setTarget(asset.asset_id);
    setPrompt(`Overview of ${asset.name}`);
    document.getElementById("prompt")?.focus();
  };

  return (
    <main className="mx-auto flex w-full max-w-[1920px] flex-col gap-4 px-4 py-5 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-text">ScreenForge</h1>
          <p className="text-sm text-muted">Describe the screen you need. Get a validated, responsive HMI.</p>
        </div>
        <SourceBadge tags={tagSource} mismatch={tagsProblem !== null} />
      </header>

      {tagsProblem && (
        <p role="status" className="rounded-lg border border-cell-border bg-surface px-4 py-2 text-sm text-text">
          <span className="numeral">GET /tags/{spec.asset_id}</span> answered, but {tagsProblem}. Showing mock values until
          the response has the expected shape.
        </p>
      )}

      <section className="rounded-xl border border-cell-border bg-surface p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <label htmlFor="prompt" className="text-xs font-semibold uppercase tracking-wider text-muted">
            Operator request
          </label>
          <div className="flex flex-col gap-3 lg:flex-row">
            <textarea
              id="prompt"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void generate();
                }
              }}
              placeholder={voice.listening ? "Listening… say what you need to see" : "e.g. Show me the conveyor motor status and any active alarms"}
              className="min-h-14 flex-1 resize-y rounded-lg border border-cell-border bg-bg px-3 py-2 text-lg text-text placeholder:text-faint focus:border-neutral-fill focus:outline-none"
            />
            <div className="flex flex-wrap gap-3 lg:w-64 lg:flex-col">
              <select
                aria-label="Machine"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="flex-1 rounded-lg border border-cell-border bg-bg px-3 py-2.5 text-sm text-text lg:flex-none"
              >
                <option value="auto">Machine: detect from request</option>
                {FIXTURE_ASSETS.map((asset) => (
                  <option key={asset.asset_id} value={asset.asset_id}>
                    {asset.name} ({asset.asset_id})
                  </option>
                ))}
              </select>
              <div className="flex flex-1 gap-3 lg:flex-none">
                <VoiceButton supported={voice.supported} listening={voice.listening} onStart={voice.start} onStop={voice.stop} />
                <button
                  type="submit"
                  disabled={running || prompt.trim() === ""}
                  className="flex-1 rounded-lg bg-neutral-fill px-5 py-2.5 text-base font-bold text-bezel hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {running ? "Generating…" : "Generate screen"}
                </button>
              </div>
            </div>
          </div>
          {voice.error && (
            <p role="status" className="text-sm text-muted">
              {voice.error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-cell-border px-3 py-1 text-xs text-muted hover:border-neutral-fill hover:text-text"
              >
                {example}
              </button>
            ))}
          </div>
        </form>
        {progress.status !== "idle" && (
          <div className="mt-4">
            <ProgressStages progress={progress} />
          </div>
        )}
      </section>

      {error && <ErrorCard error={error} apiBase={API_BASE} hasScreen />}

      <section className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          label="Panel"
          value={panel}
          onChange={setPanel}
          disabled={view === "side-by-side"}
          options={PANEL_CLASSES.map((p) => ({ value: p, label: `${PANEL_RULES[p].diagonal} ${p}` }))}
        />
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "single", label: "Single panel" },
            { value: "side-by-side", label: "All three" },
          ]}
        />
        <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
          Golden screen
          <select
            value={origin.kind === "golden" ? origin.key : ""}
            onChange={(e) => loadGolden(e.target.value)}
            className="rounded-lg border border-cell-border bg-bg px-3 py-2 text-sm font-normal normal-case tracking-normal text-text"
          >
            {origin.kind !== "golden" && <option value="">— generated screen —</option>}
            {GOLDEN_SPECS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <p className="text-sm text-muted">
        {origin.kind === "golden" ? (
          <>
            {origin.fallback ? "Pre-generated fallback screen" : "Golden fixture"}{" "}
            <code className="numeral text-text">{origin.path}</code>
          </>
        ) : (
          <>
            Generated from <q className="text-text">{origin.prompt}</q> in{" "}
            <span className="numeral">{(origin.elapsedMs / 1000).toFixed(1)} s</span>
          </>
        )}
        {" · "}
        <span className="numeral">{spec.asset_id}</span>
      </p>

      <ContextUpdateBanner
        stale={
          staleKey && context
            ? {
                from: spec.context_version,
                to: context.context_version,
                report: reconcile?.report ?? null,
                reportFailed: reconcile?.failed ?? false,
              }
            : null
        }
        regenerated={origin.kind === "generated" ? origin.contextUpdate : null}
        running={running}
        onRegenerate={regenerateForContext}
      />

      {!context && (
        <p role="alert" className="rounded-lg border border-sev-1/70 bg-cell px-4 py-3 text-sm text-text">
          No machine context for <span className="numeral">{spec.asset_id}</span> from the API or contracts/fixtures. The
          screen can&apos;t be rendered without it.
        </p>
      )}

      {context &&
        (view === "single" ? (
          <ScaleToFit width={PANEL_NOMINAL_WIDTH[panel]}>
            <PanelFrame panel={panel} spec={spec} context={context} snapshot={live.snapshot}>
              <ScreenRenderer spec={spec} panel={panel} context={context} live={live} onNavigate={navigateTo} />
            </PanelFrame>
          </ScaleToFit>
        ) : (
          <div className="flex items-start gap-4">
            {PANEL_CLASSES.map((p) => (
              // Widths proportional to nominal panel widths, so all three share one scale.
              <div key={p} style={{ flex: `${PANEL_NOMINAL_WIDTH[p]} 1 0%`, minWidth: 0 }}>
                <ScaleToFit width={PANEL_NOMINAL_WIDTH[p]}>
                  <PanelFrame panel={p} spec={spec} context={context} snapshot={live.snapshot}>
                    <ScreenRenderer spec={spec} panel={p} context={context} live={live} onNavigate={navigateTo} />
                  </PanelFrame>
                </ScaleToFit>
              </div>
            ))}
          </div>
        ))}

      <details className="rounded-xl border border-cell-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-muted">
          Screen specification JSON <span className="font-normal text-faint">· the only thing the model produces</span>
        </summary>
        <pre className="numeral max-h-[480px] overflow-auto px-4 pb-4 text-xs leading-relaxed text-muted">
          {JSON.stringify(spec, null, 2)}
        </pre>
      </details>

      <SpecValidator currentSpec={spec} />
    </main>
  );
}
