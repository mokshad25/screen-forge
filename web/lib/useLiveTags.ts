// Live tag values for one machine: polls GET /tags/{asset_id} once a second and
// falls back to the local mock simulator when /api is not reachable, so /web
// runs standalone. Keeps a ring buffer of the last 60 numeric samples per tag.

import { useEffect, useState } from "react";
import { fetchTags, tagsSnapshotProblem } from "./api";
import { MockTagSimulator } from "./mockTags";
import type { MachineContext, TagsSnapshot } from "./spec";

export const HISTORY_CAPACITY = 60;
const POLL_MS = 1000;
/** While the API is down or answering in the wrong shape, only retry it this often. */
const API_RETRY_MS = 5000;

export type TagSource = "api" | "mock" | "connecting";

export interface LiveValues {
  snapshot: TagsSnapshot | null;
  /** Oldest first, at most HISTORY_CAPACITY samples. */
  history: Record<string, number[]>;
}

interface State {
  key: string | null;
  live: LiveValues;
  source: TagSource;
  /** Set when /api answered GET /tags but the body could not be used. */
  problem: string | null;
}

const NO_VALUES: LiveValues = { snapshot: null, history: {} };

function keyOf(context: MachineContext): string {
  return `${context.asset_id}|${context.context_version}`;
}

export function useLiveTags(context: MachineContext | null): {
  live: LiveValues;
  source: TagSource;
  problem: string | null;
} {
  const [state, setState] = useState<State>({ key: null, live: NO_VALUES, source: "connecting", problem: null });

  useEffect(() => {
    if (!context) return;
    const key = keyOf(context);
    const simulator = new MockTagSimulator(context);
    let cancelled = false;
    let busy = false;
    let nextApiAttempt = 0;
    let problem: string | null = null;

    const apply = (snapshot: TagsSnapshot, source: TagSource) => {
      setState((prev) => {
        const previous = prev.key === key ? prev.live.history : {};
        const history: Record<string, number[]> = {};
        for (const [name, value] of Object.entries(snapshot.tags)) {
          if (typeof value !== "number") continue;
          const series = previous[name] ?? [];
          const kept = series.length >= HISTORY_CAPACITY ? series.slice(series.length - HISTORY_CAPACITY + 1) : series;
          history[name] = [...kept, value];
        }
        return { key, live: { snapshot, history }, source, problem };
      });
    };

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (Date.now() >= nextApiAttempt) {
          try {
            const body = await fetchTags(context.asset_id);
            if (cancelled) return;
            problem = tagsSnapshotProblem(body, context.asset_id);
            if (problem === null) {
              apply(body as TagsSnapshot, "api");
              return;
            }
          } catch {
            problem = null; // unreachable, not malformed
          }
          if (cancelled) return;
          nextApiAttempt = Date.now() + API_RETRY_MS;
        }
        apply(simulator.tick(), "mock");
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [context]);

  if (!context || state.key !== keyOf(context)) return { live: NO_VALUES, source: "connecting", problem: null };
  return { live: state.live, source: state.source, problem: state.problem };
}
