"use client";

// One connection to /events for the whole console. The API reads the plant
// once per tick and pushes values for every machine; every widget reads from
// here, so all of them show the same instant and nobody polls.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API_BASE, api } from "./api";
import type { AlarmEvent, TagsSnapshot } from "./spec";

export const HISTORY_SAMPLES = 120; // two minutes at one sample per second

type History = Record<string, Record<string, (number | null)[]>>;

export interface LiveState {
  snapshots: Record<string, TagsSnapshot>;
  /** asset -> tag -> recent numeric samples, oldest first (null = no good reading). */
  history: History;
  connected: boolean;
  /** Bumped on every tick so consumers can memo on it. */
  tick: number;
}

type AlarmListener = (event: AlarmEvent) => void;

const LiveContext = createContext<{ state: LiveState; onAlarm: (fn: AlarmListener) => () => void } | null>(null);

function take(prev: { snapshots: Record<string, TagsSnapshot>; history: History; tick: number }, snap: TagsSnapshot) {
  const perTag = { ...(prev.history[snap.asset_id] ?? {}) };
  for (const [name, value] of Object.entries(snap.tags)) {
    const good = snap.quality?.[name] === "good" && typeof value === "number";
    const series = [...(perTag[name] ?? []), good ? (value as number) : null];
    perTag[name] = series.length > HISTORY_SAMPLES ? series.slice(series.length - HISTORY_SAMPLES) : series;
  }
  return {
    snapshots: { ...prev.snapshots, [snap.asset_id]: snap },
    history: { ...prev.history, [snap.asset_id]: perTag },
    tick: prev.tick + 1,
  };
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState({ snapshots: {} as Record<string, TagsSnapshot>, history: {} as History, tick: 0 });
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<AlarmListener>());

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    // Fallback when the stream is unavailable: poll /tags for every machine.
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const assets = await api.assets();
          const snaps = await Promise.all(assets.map((a) => api.tags(a.asset_id)));
          setData((prev) => snaps.reduce(take, prev));
        } catch {
          /* API down: the header shows it */
        }
      }, 1000);
    };

    source = new EventSource(`${API_BASE}/events`);
    source.addEventListener("open", () => {
      setConnected(true);
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    });
    source.addEventListener("tags", (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as TagsSnapshot;
      setData((prev) => take(prev, snap));
    });
    source.addEventListener("alarm", (e) => {
      const event = JSON.parse((e as MessageEvent).data) as AlarmEvent;
      listeners.current.forEach((fn) => fn(event));
    });
    source.addEventListener("error", () => {
      setConnected(false);
      startPolling();
    });

    return () => {
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  const value = useMemo(
    () => ({
      state: { ...data, connected },
      onAlarm: (fn: AlarmListener) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
    }),
    [data, connected],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive outside LiveProvider");
  return ctx.state;
}

export function useAlarmEvents(fn: AlarmListener) {
  const ctx = useContext(LiveContext);
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => ctx?.onAlarm((e) => latest.current(e)), [ctx]);
}
