"use client";

import { useRef, useState } from "react";
import type { StageEvent, StageName, StageStatus } from "@/lib/spec";
import { useSpeechRecognition } from "@/lib/useSpeechRecognition";

export const STAGES: { key: StageName; label: string }[] = [
  { key: "intent", label: "Read request" },
  { key: "context", label: "Load machine" },
  { key: "llm", label: "Draft spec" },
  { key: "schema", label: "Schema" },
  { key: "whitelist", label: "Real tags only" },
  { key: "read_only", label: "Read-only gate" },
];

export type StageMap = Partial<Record<StageName, { status: StageStatus; note?: string }>>;

export function applyStage(map: StageMap, e: StageEvent): StageMap {
  let note: string | undefined;
  if (e.stage === "llm" && e.status === "running" && (e.attempt ?? 1) > 1) note = "retrying with the validator's error";
  if (e.stage === "llm" && e.status === "ok" && e.seconds !== undefined) note = `${e.seconds} s`;
  if (e.status === "failed" && e.errors?.length) note = (e.attempt ?? 1) === 1 ? "rejected, retrying" : "rejected";
  // Refusing a control request is the gate doing its job, not a failure.
  if (e.stage === "intent" && e.status === "failed") return { [e.stage]: { status: "stopped", note: "control request, refused" } };
  const next = { ...map, [e.stage]: { status: e.status, note } };
  // A retry re-runs validation: clear the checks below the model for the second pass.
  if (e.stage === "llm" && e.status === "running" && (e.attempt ?? 1) > 1) {
    delete next.schema;
    delete next.whitelist;
    delete next.read_only;
  }
  return next;
}

interface CommandBarProps {
  mode: "new" | "edit";
  canEdit: boolean;
  onMode: (mode: "new" | "edit") => void;
  busy: boolean;
  stages: StageMap;
  llmReady: boolean;
  suggestions: string[];
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function CommandBar({ mode, canEdit, onMode, busy, stages, llmReady, suggestions, onSubmit, onCancel }: CommandBarProps) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeechRecognition((transcript, isFinal) => {
    setText(transcript);
    if (isFinal && transcript.trim()) onSubmit(transcript.trim());
  });

  const submit = () => {
    const t = text.trim();
    if (t && !busy) onSubmit(t);
  };
  const placeholder =
    mode === "edit"
      ? "Change this screen: make the trend bigger, add evaporator pressure, drop the comms tiles"
      : "What do you need to watch? e.g. condenser pressure keeps spiking, give me what I need to watch it";
  const shown = Object.keys(stages).length > 0;

  return (
    <div className="border-t border-rule bg-chrome px-4 py-3">
      <div className="mb-2 flex items-center gap-3">
        <div role="radiogroup" aria-label="What the request does" className="flex border border-ink-2">
          {(["new", "edit"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={m === "edit" && !canEdit}
              onClick={() => onMode(m)}
              className={`px-3 py-1 text-sm font-semibold disabled:opacity-40 ${mode === m ? "bg-ink text-chrome" : "hover:bg-chrome-2"}`}>
              {m === "new" ? "New screen" : "Edit this screen"}
            </button>
          ))}
        </div>
        {!llmReady && (
          <p className="text-xs text-ink-2">
            No LLM key on the API (api/.env). Alarm screens and saved screens still work.
          </p>
        )}
      </div>
      <form className="flex items-stretch gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor="sf-request" className="sr-only">Request</label>
        <textarea id="sf-request" ref={input} rows={1} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={placeholder} disabled={busy}
          className="min-h-11 flex-1 resize-none border border-ink-2 bg-well px-3 py-2.5 text-[15px] placeholder:text-ink-faint focus:border-control focus:outline-none disabled:opacity-60" />
        {speech.supported && (
          <button type="button" onClick={() => (speech.listening ? speech.stop() : speech.start())} disabled={busy}
            aria-pressed={speech.listening}
            className={`w-24 border px-2 text-sm font-semibold ${speech.listening ? "border-control bg-control text-white" : "border-ink-2 bg-well hover:bg-chrome-2"}`}>
            {speech.listening ? "Listening" : "Speak"}
          </button>
        )}
        {busy ? (
          <button type="button" onClick={onCancel} className="w-28 border border-ink-2 bg-well text-sm font-semibold hover:bg-chrome-2">
            Cancel
          </button>
        ) : (
          <button type="submit" disabled={!text.trim() || !llmReady}
            className="w-28 bg-control text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40">
            {mode === "edit" ? "Apply" : "Build screen"}
          </button>
        )}
      </form>
      {speech.error && <p className="mt-1 text-xs text-ink-2">{speech.error}</p>}
      {shown ? (
        <ol className="mt-2 flex flex-wrap gap-x-1 gap-y-1 text-xs" aria-label="Progress">
          {STAGES.map(({ key, label }, i) => {
            const s = stages[key];
            const look =
              s?.status === "stopped" ? "border-ink bg-well text-ink font-semibold" :
              s?.status === "ok" ? "border-ink-2 bg-well text-ink" :
              s?.status === "failed" ? "border-alarm-1 bg-well text-alarm-1 font-semibold" :
              s?.status === "running" ? "border-control bg-well text-control font-semibold" : "border-rule text-ink-faint";
            const mark = s?.status === "stopped" ? "■" : s?.status === "ok" ? "✓" : s?.status === "failed" ? "✕" : s?.status === "running" ? "…" : String(i + 1);
            return (
              <li key={key} className={`flex items-center gap-1.5 border px-2 py-1 ${look}`}>
                <span aria-hidden className="w-3 text-center">{mark}</span>
                {label}
                {s?.note && <span className="font-normal text-ink-2">{s.note}</span>}
              </li>
            );
          })}
        </ol>
      ) : (
        suggestions.length > 0 && mode === "new" && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => { setText(s); input.current?.focus(); }}
                className="border border-rule bg-well px-2 py-0.5 text-xs text-ink-2 hover:border-ink-2 hover:text-ink">
                {s}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
