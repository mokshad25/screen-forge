export const STAGES = ["Parsing intent", "Retrieving context", "Generating spec", "Validating"] as const;

/**
 * Which progress stage an /api error stage belongs to. The contract doesn't fix
 * stage names, so unknown or missing stages are shown as failing at validation.
 */
export const STAGE_OF_ERROR: Record<string, number> = {
  request: 0,
  intent: 0,
  context: 1,
  llm: 2,
  generation: 2,
  schema: 3,
  whitelist: 3,
  // /api refuses control requests while reading the request, before any generation.
  read_only: 0,
};

export interface GenerationProgress {
  status: "idle" | "running" | "done" | "failed";
  /** Index of the stage in progress; STAGES.length once everything is done. */
  active: number;
  failed: number | null;
  elapsedMs: number | null;
}

export const IDLE_PROGRESS: GenerationProgress = { status: "idle", active: 0, failed: null, elapsedMs: null };

type StageState = "pending" | "active" | "done" | "failed";

function stateOf(index: number, progress: GenerationProgress): StageState {
  if (progress.failed === index) return "failed";
  if (index < progress.active) return "done";
  if (index === progress.active && progress.status === "running") return "active";
  return "pending";
}

function StageIcon({ state }: { state: StageState }) {
  const base = "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold";
  switch (state) {
    case "done":
      return <span className={`${base} bg-neutral-fill text-bezel`}>✓</span>;
    case "failed":
      return <span className={`${base} border-2 border-sev-1 text-sev-1`}>✕</span>;
    case "active":
      return <span className={`${base} animate-spin border-2 border-neutral-fill border-t-transparent`} />;
    case "pending":
      return <span className={`${base} border-2 border-cell-border`} />;
  }
}

export function ProgressStages({ progress }: { progress: GenerationProgress }) {
  if (progress.status === "idle") return null;

  return (
    <div className="flex flex-col gap-2">
      <ol className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Generation progress">
        {STAGES.map((label, index) => {
          const state = stateOf(index, progress);
          return (
            <li
              key={label}
              aria-current={state === "active" ? "step" : undefined}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                state === "active" ? "border-neutral-fill text-text" : "border-cell-border"
              } ${state === "pending" ? "text-faint" : "text-text"}`}
            >
              <StageIcon state={state} />
              <span className="font-medium">{label}</span>
            </li>
          );
        })}
      </ol>
      {progress.elapsedMs !== null && (
        <p className="numeral text-xs text-faint">
          {progress.status === "done" ? "Screen ready" : "Stopped"} after {(progress.elapsedMs / 1000).toFixed(1)} s
        </p>
      )}
    </div>
  );
}
