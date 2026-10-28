// Client for the /api endpoints in the frozen contract (CLAUDE.md):
//   POST /generate { prompt, asset_id, panel_class } -> { spec } | { error }
//   GET  /tags/{asset_id} -> live values

import type { GenerateResponse, MachineContext, PanelClass, ReconcileReport, ScreenSpec } from "./spec";

// 127.0.0.1 rather than "localhost": uvicorn listens on IPv4 only, and on Windows
// "localhost" tries IPv6 (::1) first, which added ~2 s to requests. CORS is
// unaffected -- /api checks the page's origin (http://localhost:3000), not this URL.
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "");

/** The API could not be reached at all (refused, DNS, timeout). */
export class ApiUnreachableError extends Error {}

async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
  } catch {
    throw new ApiUnreachableError(
      controller.signal.aborted
        ? `No response from ${API_BASE}${path} within ${timeoutMs / 1000} s.`
        : `Cannot reach the ScreenForge API at ${API_BASE}.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raw GET /tags body. Check it with tagsSnapshotProblem before use. */
export async function fetchTags(assetId: string): Promise<unknown> {
  const res = await request(`/tags/${encodeURIComponent(assetId)}`, { headers: { Accept: "application/json" } }, 1500);
  if (!res.ok) throw new Error(`GET /tags returned HTTP ${res.status}.`);
  return res.json();
}

/**
 * Why a GET /tags body can't be used, or null when it has the shape /web expects:
 * { asset_id, context_version, timestamp, tags: { name: value }, alarms: { id: active } }.
 */
export function tagsSnapshotProblem(value: unknown, assetId: string): string | null {
  if (!isObject(value)) return "the body is not a JSON object";
  if (!isObject(value.tags)) return "it has no `tags` object of tag values";
  if (!isObject(value.alarms)) return "it has no `alarms` object of alarm states";
  if (value.asset_id !== assetId) return `its asset_id is ${String(value.asset_id)}, expected ${assetId}`;
  if (typeof value.context_version !== "string") return "it has no context_version";
  if (typeof value.timestamp !== "string" && typeof value.timestamp !== "number") return "it has no timestamp";
  return null;
}

/** GET /context/{asset_id}: the context the API is generating against right now. */
export async function fetchContext(assetId: string): Promise<MachineContext> {
  const res = await request(`/context/${encodeURIComponent(assetId)}`, { headers: { Accept: "application/json" } }, 3000);
  if (!res.ok) throw new Error(`GET /context returned HTTP ${res.status}.`);
  const body: unknown = await res.json();
  const ok =
    isObject(body) &&
    body.asset_id === assetId &&
    typeof body.context_version === "string" &&
    Array.isArray(body.tags) &&
    Array.isArray(body.alarms) &&
    Array.isArray(body.comms) &&
    Array.isArray(body.asset_hierarchy);
  if (!ok) throw new Error("GET /context returned something that is not a machine context.");
  return body as unknown as MachineContext;
}

/**
 * POST /reconcile on any JSON value. /api's validator and reconciler judge it:
 * what changed since it was built, which bindings no longer exist, and whether
 * it is still valid. Nothing is repaired.
 */
export async function checkSpec(value: unknown): Promise<ReconcileReport> {
  const res = await request(
    "/reconcile",
    { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ spec: value }) },
    // Generous: an operator pressed a button and can wait; a false "couldn't validate" in a demo is worse.
    15000,
  );
  const body: unknown = await res.json().catch(() => null);
  if (isObject(body) && typeof body.stale === "boolean" && Array.isArray(body.broken_bindings)) {
    return body as unknown as ReconcileReport;
  }
  let message = `/reconcile returned HTTP ${res.status}`;
  if (isObject(body) && isObject(body.error) && typeof body.error.message === "string") message = body.error.message;
  else if (isObject(body) && "detail" in body) message = `The API rejected the request body (HTTP ${res.status}).`;
  throw new Error(message);
}

export function reconcileScreen(spec: ScreenSpec): Promise<ReconcileReport> {
  return checkSpec(spec);
}

export interface GenerateRequest {
  prompt: string;
  asset_id: string | null;
  panel_class: PanelClass;
  /** When regenerating a stale screen: the version it was built for, so /api tells the model what's new. */
  since_context_version?: string | null;
  /** When regenerating a stale screen: that screen's spec, so /api keeps what the operator can already see. */
  previous_spec?: ScreenSpec | null;
}

/**
 * Minimal structural check so a broken response shows a readable error instead
 * of crashing the renderer. This is NOT the validator (that lives in /api) and it
 * never repairs anything: a spec either passes as-is or is refused.
 */
export function looksLikeSpec(value: unknown): value is ScreenSpec {
  if (!isObject(value)) return false;
  if (typeof value.asset_id !== "string" || typeof value.title !== "string") return false;
  if (typeof value.context_version !== "string") return false;
  if (!isObject(value.permissions) || value.permissions.mode !== "read_only") return false;
  if (!Array.isArray(value.components)) return false;
  return value.components.every(
    (c) =>
      isObject(c) &&
      typeof c.id === "string" &&
      typeof c.type === "string" &&
      typeof c.priority === "number" &&
      typeof c.size_hint === "string",
  );
}

/** POST /generate. Reads the body whatever the HTTP status. */
export async function generateScreen(body: GenerateRequest): Promise<GenerateResponse> {
  const res = await request(
    "/generate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    90_000,
  );

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`/generate returned HTTP ${res.status} with a body that is not JSON.`);
  }

  // FastAPI rejects a request body that doesn't match its model with
  // { detail: [{ loc: ["body", "asset_id"], msg }] } before /generate runs.
  if (isObject(payload) && "detail" in payload && !("error" in payload)) {
    const items = Array.isArray(payload.detail) ? payload.detail : [payload.detail];
    const problems = items.map((item) => {
      if (!isObject(item)) return String(item);
      const loc = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(".") : "";
      return loc ? `${loc}: ${String(item.msg)}` : String(item.msg);
    });
    const first = items[0];
    const field = isObject(first) && Array.isArray(first.loc) ? first.loc.filter((part) => part !== "body").join(".") : null;
    return {
      error: {
        message: `The API rejected the request (HTTP ${res.status}): ${problems.join("; ")}`,
        stage: "request",
        field: field || null,
      },
    };
  }

  // The contract doesn't fix the error shape: accept a plain string or an object with a message.
  if (isObject(payload) && "error" in payload) {
    const error = payload.error;
    if (typeof error === "string") return { error: { message: error } };
    if (isObject(error) && typeof error.message === "string") {
      return {
        error: {
          message: error.message,
          stage: typeof error.stage === "string" ? error.stage : undefined,
          field: typeof error.field === "string" ? error.field : null,
          details: error.details,
        },
      };
    }
  }
  if (isObject(payload) && looksLikeSpec(payload.spec)) {
    return { spec: payload.spec, meta: isObject(payload.meta) ? payload.meta : undefined };
  }
  throw new Error(`/generate returned HTTP ${res.status} without a usable { spec } or { error } body.`);
}
