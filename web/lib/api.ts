// Client for the ScreenForge API. Every screen endpoint answers
// { spec } or { error }; streams are Server-Sent Events.

import type {
  ApiError,
  AssetSummary,
  GenerateResult,
  Health,
  LogEntry,
  MachineContext,
  PanelClass,
  ReconcileReport,
  SavedScreenSummary,
  ScreenSpec,
  StageEvent,
  TagsSnapshot,
} from "./spec";

// 127.0.0.1 rather than "localhost": uvicorn listens on IPv4, and on Windows
// "localhost" tries IPv6 first, which costs seconds per request.
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const PLANT_BASE = (process.env.NEXT_PUBLIC_PLANT_CONTROL ?? "http://127.0.0.1:8090").replace(/\/$/, "");

export class ApiUnreachableError extends Error {}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000, base = API_BASE): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      signal: controller.signal,
    });
  } catch {
    throw new ApiUnreachableError(
      controller.signal.aborted ? `No answer from ${base}${path} in ${timeoutMs / 1000} s.` : `Cannot reach ${base}.`,
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? String(body.detail) : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown, timeoutMs?: number) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }, timeoutMs);

export const api = {
  health: () => call<Health>("/health", {}, 4000),
  assets: () => call<AssetSummary[]>("/assets"),
  context: (assetId: string) => call<MachineContext>(`/context/${encodeURIComponent(assetId)}`),
  tags: (assetId: string) => call<TagsSnapshot>(`/tags/${encodeURIComponent(assetId)}`, {}, 3000),
  bump: (assetId: string) => post<{ changed: boolean; context_version: string; reason?: string }>(`/context/${encodeURIComponent(assetId)}/bump`, {}),
  reset: (assetId: string) => post<{ context_version: string }>(`/context/${encodeURIComponent(assetId)}/reset`, {}),
  reconcile: (spec: unknown) => post<ReconcileReport | { error: ApiError }>("/reconcile", { spec }),
  alarmScreen: (assetId: string, alarmId: string) =>
    call<GenerateResult>(`/alarms/${encodeURIComponent(assetId)}/${encodeURIComponent(alarmId)}/screen`),
  ack: (assetId: string, alarmId: string) =>
    post<{ acked: boolean; reason?: string }>(`/alarms/${encodeURIComponent(assetId)}/${encodeURIComponent(alarmId)}/ack`, {}),
  screens: () => call<SavedScreenSummary[]>("/screens"),
  screen: (id: string) => call<{ spec: ScreenSpec; reconcile: ReconcileReport | null }>(`/screens/${encodeURIComponent(id)}`),
  saveScreen: (spec: ScreenSpec) => post<{ screen: SavedScreenSummary } | { error: ApiError }>("/screens", { spec }),
  deleteScreen: (id: string) => call<{ deleted: boolean }>(`/screens/${encodeURIComponent(id)}`, { method: "DELETE" }),
  log: (limit = 60) => call<LogEntry[]>(`/log?limit=${limit}`),
  importBrowse: (endpoint: string) =>
    post<{ assets: { asset_id: string; name: string; known: boolean }[] } | { error: ApiError }>("/import/opcua", { endpoint }, 15_000),
  importAsset: (endpoint: string, assetId: string) =>
    post<{ context: MachineContext; created: boolean; changed: boolean } | { error: ApiError }>(
      "/import/opcua",
      { endpoint, asset_id: assetId },
      20_000,
    ),
  simFault: (assetId: string, tag: string, value: number | boolean, seconds = 25) =>
    post<{ injected?: boolean; error?: ApiError }>("/sim/fault", { asset_id: assetId, tag, value, seconds }),
};

/** The simulated plant's own control port (live mode). Not part of ScreenForge. */
export const plant = {
  status: () => call<{ links: Record<string, boolean>; values: Record<string, number | boolean> }>("/", {}, 3000, PLANT_BASE),
  fault: (tag: string, value: number | boolean, seconds = 25) =>
    call("/fault", { method: "POST", body: JSON.stringify({ tag, value, seconds }) }, 5000, PLANT_BASE),
  link: (device: string, up: boolean) =>
    call("/link", { method: "POST", body: JSON.stringify({ device, up }) }, 8000, PLANT_BASE),
  reset: () => call("/reset", { method: "POST", body: "{}" }, 8000, PLANT_BASE),
};

/**
 * POST a body and read the Server-Sent Events the API streams back: stage
 * events while it works, then one result. EventSource can't POST, so this
 * reads the stream by hand.
 */
async function streamPost(
  path: string,
  body: unknown,
  onStage: (event: StageEvent) => void,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiUnreachableError(`Cannot reach the ScreenForge API at ${API_BASE}.`);
  }
  if (!res.ok || !res.body) {
    return { error: { message: `The API answered HTTP ${res.status}.`, stage: "request" } };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "stage") onStage(parsed as StageEvent);
      if (event === "result") return parsed as GenerateResult;
    }
  }
  return { error: { message: "The stream ended without a result.", stage: "llm" } };
}

export function generateStream(
  body: {
    prompt: string;
    asset_id: string | null;
    panel_class: PanelClass;
    since_context_version?: string | null;
    previous_spec?: ScreenSpec | null;
  },
  onStage: (e: StageEvent) => void,
  signal?: AbortSignal,
) {
  return streamPost("/generate/stream", body, onStage, signal);
}

export function editStream(
  body: { instruction: string; spec: ScreenSpec; panel_class: PanelClass },
  onStage: (e: StageEvent) => void,
  signal?: AbortSignal,
) {
  return streamPost("/edit/stream", body, onStage, signal);
}
