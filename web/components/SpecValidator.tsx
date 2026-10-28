"use client";

import { useState } from "react";
import { checkSpec } from "@/lib/api";
import { GOLDEN_SPECS } from "@/lib/contracts";
import type { ReconcileReport, ScreenSpec } from "@/lib/spec";

type Result =
  | { kind: "report"; report: ReconcileReport }
  | { kind: "not-json"; message: string }
  | { kind: "failed"; message: string };

// Deliberately broken variants of the golden status-and-alarms screen (Conveyor A),
// one per thing the validator must refuse.
const BASE = GOLDEN_SPECS[0].spec;
const clone = (): ScreenSpec => structuredClone(BASE);

const EXAMPLES: { label: string; build: () => unknown }[] = [
  {
    label: "Unknown tag",
    build: () => {
      const spec = clone();
      spec.components[2] = { ...spec.components[2], bind_tag: "Motr_Speed" };
      return spec;
    },
  },
  {
    label: "Binds a write tag",
    build: () => {
      const spec = clone();
      spec.components[1] = { ...spec.components[1], bind_tag: "Motor_Start" };
      return spec;
    },
  },
  {
    label: "Pixel position",
    build: () => {
      const spec = clone();
      return { ...spec, components: spec.components.map((c, i) => (i === 0 ? { ...c, x: 120, y: 40, width: 600 } : c)) };
    },
  },
  {
    label: "Write permission",
    build: () => ({ ...clone(), permissions: { mode: "read_write" } }),
  },
];

const chip =
  "rounded-full border border-cell-border px-3 py-1 text-xs text-muted hover:border-neutral-fill hover:text-text";

function ValidationResult({ result }: { result: Result }) {
  if (result.kind === "not-json") {
    return (
      <section role="alert" className="rounded-lg border border-sev-1/70 bg-cell p-3 text-sm text-text">
        <p className="font-bold">✕ Not valid JSON</p>
        <p className="numeral mt-1 text-xs text-muted">{result.message}</p>
      </section>
    );
  }
  if (result.kind === "failed") {
    return (
      <section role="alert" className="rounded-lg border border-sev-1/70 bg-cell p-3 text-sm text-text">
        <p className="font-bold">✕ Couldn&apos;t validate</p>
        <p className="numeral mt-1 text-xs text-muted">{result.message}</p>
      </section>
    );
  }

  const { report } = result;
  if (report.still_valid) {
    return (
      <section role="status" className="rounded-lg border border-cell-border bg-cell p-3 text-sm text-text">
        <p className="font-bold">✓ Valid: passes the schema, whitelist and read-only checks</p>
        <p className="mt-1 text-muted">
          For <span className="numeral">{report.asset_id}</span>
          {report.stale
            ? `, built for ${report.spec_context_version}; the machine is now on ${report.current_context_version}.`
            : ` at ${report.current_context_version}.`}
        </p>
      </section>
    );
  }
  return (
    <section role="alert" className="rounded-lg border border-sev-1/70 bg-cell p-3 text-sm text-text">
      <p className="font-bold">✕ Rejected by the validator. Nothing was repaired, so nothing would render.</p>
      <ul className="numeral mt-2 list-disc space-y-1 pl-5 text-xs">
        {report.errors.length > 0 ? report.errors.map((error) => <li key={error}>{error}</li>) : <li>(no details returned)</li>}
      </ul>
    </section>
  );
}

/** Paste a screen spec and let /api's validator judge it (demo step: a malformed spec is refused readably). */
export function SpecValidator({ currentSpec }: { currentSpec: ScreenSpec }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (value: unknown) => {
    setText(JSON.stringify(value, null, 2));
    setResult(null);
  };

  const validate = async () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      setResult({ kind: "not-json", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setBusy(true);
    try {
      setResult({ kind: "report", report: await checkSpec(value) });
    } catch (e) {
      setResult({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-xl border border-cell-border bg-surface" data-spec-validator>
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-muted">
        Validate a screen spec{" "}
        <span className="font-normal text-faint">· paste JSON; /api&apos;s validator decides and never repairs it</span>
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">Load</span>
          <button type="button" onClick={() => load(currentSpec)} className={chip}>
            Current screen
          </button>
          {EXAMPLES.map((example) => (
            <button key={example.label} type="button" onClick={() => load(example.build())} className={chip}>
              Broken: {example.label}
            </button>
          ))}
        </div>
        <textarea
          aria-label="Screen spec JSON to validate"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          rows={12}
          spellCheck={false}
          placeholder='{ "screen_id": "...", "asset_id": "...", "components": [ ... ] }'
          className="numeral w-full resize-y rounded-lg border border-cell-border bg-bg px-3 py-2 text-xs text-text placeholder:text-faint focus:border-neutral-fill focus:outline-none"
        />
        <div>
          <button
            type="button"
            onClick={() => void validate()}
            disabled={busy || text.trim() === ""}
            className="rounded-lg bg-neutral-fill px-4 py-2 text-sm font-bold text-bezel hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Validating…" : "Validate"}
          </button>
        </div>
        {result && <ValidationResult result={result} />}
      </div>
    </details>
  );
}
