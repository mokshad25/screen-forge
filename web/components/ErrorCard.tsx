import type { GenerateError } from "@/lib/spec";

export type ConsoleError =
  | { kind: "api"; error: GenerateError }
  | { kind: "unreachable"; message: string }
  | { kind: "client"; message: string };

// Keyed by the stage names /web expects from /api. Unknown stages fall back to a generic title.
const STAGE_TITLE: Record<string, string> = {
  request: "The API rejected the request",
  intent: "Couldn't work out which machine or what to show",
  context: "Machine context unavailable",
  llm: "The model didn't produce a screen",
  generation: "The model didn't produce a screen",
  schema: "Rejected: the spec broke the screen contract",
  whitelist: "Rejected: unknown tag or alarm for this machine",
  read_only: "Blocked: screens are read-only",
};

const STAGE_HINT: Record<string, string> = {
  request: "/web and /api disagree on the request shape (see web/README.md). Picking a machine from the list may work around it.",
  intent: "Name the machine (for example “the conveyor” or “the chiller”) or pick it from the machine list.",
  context: "The machine's context could not be loaded, so nothing could be generated for it.",
  llm: "The model call failed or timed out. Try again.",
  generation: "The model call failed or timed out. Try again.",
  schema: "The generated spec did not match contracts/screen-spec.schema.json, so it was not rendered. Specs are never auto-repaired.",
  whitelist: "The spec referenced something that does not exist on this machine. Every binding must come from its context.",
  read_only: "ScreenForge monitors machines but never writes to them. Ask to view or monitor the value instead.",
};

export function ErrorCard({ error, apiBase, hasScreen }: { error: ConsoleError; apiBase: string; hasScreen: boolean }) {
  let title: string;
  let message: string;
  let hint: string | null = null;
  let stage: string | undefined;
  let field: string | null = null;
  let details: unknown;

  if (error.kind === "api") {
    stage = error.error.stage;
    title = (stage && STAGE_TITLE[stage]) || "Screen generation failed";
    message = error.error.message;
    // /api's read-only refusal already explains itself; the generic hint would only repeat it.
    hint = stage === "read_only" ? null : (stage && STAGE_HINT[stage]) || null;
    field = error.error.field ?? null;
    details = error.error.details;
  } else if (error.kind === "unreachable") {
    title = "Can't reach the ScreenForge API";
    message = error.message;
    hint = `Live generation needs /api running at ${apiBase}. Golden screens still work offline.`;
  } else {
    title = "Unexpected response";
    message = error.message;
  }

  return (
    <section role="alert" className="rounded-xl border border-sev-1/70 bg-cell p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-text">{title}</h2>
        {stage && <span className="numeral rounded border border-cell-border px-2 py-0.5 text-xs text-muted">stage: {stage}</span>}
      </div>
      <p className="mt-1 text-base text-text">{message}</p>
      {field && (
        <p className="mt-2 text-sm text-muted">
          Field: <code className="numeral rounded bg-bg px-1.5 py-0.5 text-text">{field}</code>
        </p>
      )}
      {hint && <p className="mt-2 text-sm text-muted">{hint}</p>}
      {details !== undefined && details !== null && (
        <details className="mt-2 text-sm text-muted">
          <summary className="cursor-pointer">Details</summary>
          <pre className="numeral mt-1 max-h-60 overflow-auto rounded bg-bg p-2 text-xs">{JSON.stringify(details, null, 2)}</pre>
        </details>
      )}
      {hasScreen && <p className="mt-3 text-xs text-faint">The previous screen is still shown below.</p>}
    </section>
  );
}
