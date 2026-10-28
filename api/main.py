"""
ScreenForge API.

    uvicorn main:app --port 8000          (from api/)
    http://localhost:8000/docs            interactive docs for every endpoint

Every endpoint that answers about a screen returns HTTP 200 with either
{"spec": ...} or {"error": {"message", "stage", "field"}} -- the caller checks
which key is present. Streams (/generate/stream, /edit/stream, /events) are
Server-Sent Events.

Nothing here writes to a machine. Tag values are read by acquisition.py; the
only "writes" are to ScreenForge's own database (screens, audit log, local
alarm acknowledgement).
"""

from dotenv import load_dotenv

load_dotenv()  # before generator is imported: it reads the LLM key at call time

import asyncio
import json
import logging
import os
import queue
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import acquisition
import alarms
import context_store
import generator
import intent
import opcua_import
import reconciler
import specdiff
import store
import tag_simulator
import troubleshoot
import validator

VERSION = "2.0.0"
log = logging.getLogger("screenforge")


# --------------------------------------------------------------- lifecycle

def _on_alarm(ctx: dict, transition: dict) -> dict | None:
    """When an alarm raises, attach its troubleshooting screen to the event."""
    if transition["event"] != "raised":
        return None
    try:
        return {"screen": troubleshoot.build_alarm_screen(ctx, transition["alarm_id"])}
    except Exception:
        log.exception("could not build troubleshooting screen for %s", transition["alarm_id"])
        return None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    acquisition.on_alarm_transition = _on_alarm
    acquisition.start()
    yield
    await acquisition.stop()


app = FastAPI(title="ScreenForge API", version=VERSION, lifespan=lifespan)

_origins = [o.strip() for o in os.environ.get(
    "SCREENFORGE_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["GET", "POST", "DELETE"],
                   allow_headers=["Content-Type"])


# ------------------------------------------------------------ rate limiting

# LLM calls cost money and take seconds. A per-client sliding window keeps one
# browser (or one script) from burning the quota for everyone.
_LLM_LIMIT = int(os.environ.get("SCREENFORGE_LLM_PER_MINUTE", "12"))
_calls: dict[str, deque] = defaultdict(deque)
_calls_lock = threading.Lock()


def _rate_limited(request: Request) -> dict | None:
    client = request.client.host if request.client else "unknown"
    now = time.time()
    with _calls_lock:
        window = _calls[client]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= _LLM_LIMIT:
            wait = int(60 - (now - window[0])) + 1
            return {"message": f"Too many screen requests from this client. Try again in {wait} s.",
                    "stage": "request", "field": None}
        window.append(now)
    return None


# ------------------------------------------------------------------ status

@app.get("/health")
def health():
    try:
        provider, model = generator.llm_provider()
        llm = {"configured": True, "provider": provider, "model": model}
    except RuntimeError:
        llm = {"configured": False}
    return {
        "status": "ok",
        "version": VERSION,
        "known_assets": context_store.list_asset_ids(),
        "tag_source": acquisition.status(),
        "llm": llm,
    }


@app.get("/assets")
def list_assets():
    out = []
    for ctx in context_store.all_contexts():
        snap = alarms.snapshot(ctx)
        out.append({
            "asset_id": ctx["asset_id"],
            "name": ctx["asset_hierarchy"][-1],
            "hierarchy": ctx["asset_hierarchy"],
            "context_version": ctx["context_version"],
            "origin": store.context_origin(ctx["asset_id"], ctx["context_version"]) or "fixture",
            "tag_count": len(ctx["tags"]),
            "active_alarms": sorted(
                [{"id": aid, "priority": s["priority"], "desc": s["desc"], "acked": s["acked"]}
                 for aid, s in snap.items() if s["active"]],
                key=lambda a: alarms.PRIORITY_RANK[a["priority"]],
            ),
        })
    return out


@app.get("/tags/{asset_id:path}")
def get_tags(asset_id: str):
    """Latest values for one machine, with quality and alarm states."""
    try:
        return acquisition.latest(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/events")
async def events(request: Request):
    """Server-Sent Events: every tick's values for every machine, and alarm transitions."""
    q = acquisition.hub.subscribe()

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"event: {event['type']}\ndata: {json.dumps(event, default=str)}\n\n"
        finally:
            acquisition.hub.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- contexts

@app.get("/context/{asset_id:path}")
def get_machine_context(asset_id: str):
    try:
        return context_store.get_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/context/{asset_id:path}/bump")
def bump_context(asset_id: str):
    """Demo: a vibration sensor is fitted to the machine at runtime."""
    try:
        context_store.get_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    result = reconciler.bump_context(asset_id)
    if result.get("changed"):
        store.log_event("context_changed", asset_id, version=result["context_version"],
                        changes=result.get("changes"))
    return result


@app.post("/context/{asset_id:path}/reset")
def reset_context(asset_id: str):
    try:
        context = context_store.reset_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    alarms.reset(asset_id)
    store.log_event("context_reset", asset_id, version=context["context_version"])
    return {"context_version": context["context_version"], "context": context}


class ImportRequest(BaseModel):
    endpoint: str
    asset_id: str | None = None


@app.post("/import/opcua")
async def import_opcua(req: ImportRequest):
    """
    Browse an OPC UA server. Without asset_id: list the assets it serves.
    With asset_id: build that machine's context from the server and add it.
    """
    try:
        if not req.asset_id:
            return {"assets": await opcua_import.list_assets(req.endpoint)}
        result = await opcua_import.import_asset(req.endpoint, req.asset_id)
    except opcua_import.ImportRefused as e:
        return {"error": {"message": str(e), "stage": "context", "field": "endpoint"}}
    except (OSError, asyncio.TimeoutError) as e:
        return {"error": {"message": f"Could not reach {req.endpoint}: {e or type(e).__name__}",
                          "stage": "context", "field": "endpoint"}}
    if result["changed"]:
        store.log_event("context_imported", req.asset_id, endpoint=req.endpoint,
                        version=result["context"]["context_version"], tags=len(result["context"]["tags"]))
    return result


class ReconcileRequest(BaseModel):
    # Typed loosely on purpose: the validate-a-spec panel accepts anything a
    # person pastes, and it should get our error shape, not FastAPI's 422.
    spec: object = None


@app.post("/reconcile")
def reconcile(req: ReconcileRequest):
    spec = req.spec
    if not isinstance(spec, dict):
        return {"error": {
            "message": f"A screen spec must be a JSON object, got {type(spec).__name__}. Expected keys: "
                       "screen_id, title, asset_id, context_version, components, permissions.",
            "stage": "schema", "field": "spec"}}
    if "asset_id" not in spec:
        return {"error": {
            "message": f"This spec has no asset_id, so there is no machine context to check it against "
                       f"(known asset_ids: {context_store.list_asset_ids()}).",
            "stage": "schema", "field": "asset_id"}}
    try:
        return reconciler.reconcile(spec)
    except context_store.ContextNotFoundError as e:
        return {"error": {"message": str(e), "stage": "context", "field": "asset_id"}}


# ------------------------------------------------------------- generation

class GenerateRequest(BaseModel):
    prompt: str
    asset_id: str | None = None   # null: work the machine out from the prompt
    panel_class: str = "large"
    since_context_version: str | None = None
    previous_spec: dict | None = None


class EditRequest(BaseModel):
    instruction: str
    spec: dict
    panel_class: str = "large"


def _resolve(req: GenerateRequest) -> tuple[str | None, dict | None]:
    asset_id = (req.asset_id or "").strip() or intent.resolve_asset_id(req.prompt)
    # The read-only gate goes before "which machine?": "start the motor" should
    # be told why we won't, not asked which motor.
    if intent.control_request(req.prompt):
        return asset_id, generator.read_only_error(asset_id, req.prompt)
    if not asset_id:
        return None, {
            "message": "Could not tell which machine this request is about. Name the machine, "
                       f"or pick one (known: {', '.join(context_store.list_asset_ids())}).",
            "stage": "intent", "field": "asset_id"}
    return asset_id, None


def _audit_generated(kind: str, asset_id: str | None, text: str, spec: dict | None, error: dict | None,
                     started: float, extra: dict | None = None) -> None:
    store.log_event(kind, asset_id, request=text[:300], ok=spec is not None,
                    screen_id=(spec or {}).get("screen_id"), error_stage=(error or {}).get("stage"),
                    seconds=round(time.time() - started, 2), **(extra or {}))


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _stream(work) -> StreamingResponse:
    """Run work(on_stage) in a thread; stream its stage events, then its result."""
    events: queue.Queue = queue.Queue()

    def on_stage(stage: str, status: str, detail: dict) -> None:
        events.put(("stage", {"stage": stage, "status": status, **detail}))

    def runner():
        try:
            events.put(("result", work(on_stage)))
        except Exception as e:  # never leave the client hanging
            log.exception("stream work failed")
            events.put(("result", {"error": {"message": f"Internal error: {e}", "stage": "llm", "field": None}}))

    threading.Thread(target=runner, daemon=True).start()

    def body():
        while True:
            kind, data = events.get()
            yield _sse(kind, data)
            if kind == "result":
                return

    return StreamingResponse(body(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _generate(req: GenerateRequest, on_stage=generator._noop) -> dict:
    started = time.time()
    asset_id, error = _resolve(req)
    if error:
        on_stage("intent", "failed", {})
        _audit_generated("generate", asset_id, req.prompt, None, error, started)
        return {"error": error}
    spec, error = generator.generate_and_validate(
        req.prompt, asset_id, req.panel_class,
        since_context_version=req.since_context_version,
        previous_spec=req.previous_spec, on_stage=on_stage,
    )
    _audit_generated("generate", asset_id, req.prompt, spec, error, started)
    return {"error": error} if error else {"spec": spec, "meta": {"seconds": round(time.time() - started, 2)}}


@app.post("/generate")
def generate(req: GenerateRequest, request: Request):
    limited = _rate_limited(request)
    return {"error": limited} if limited else _generate(req)


@app.post("/generate/stream")
def generate_stream(req: GenerateRequest, request: Request):
    limited = _rate_limited(request)
    if limited:
        return _stream(lambda on_stage: {"error": limited})
    return _stream(lambda on_stage: _generate(req, on_stage))


def _edit(req: EditRequest, on_stage=generator._noop) -> dict:
    started = time.time()
    current = validator.validate_spec(req.spec)
    if not current.valid:
        error = {"message": "The screen being edited is not a valid spec: " + "; ".join(current.errors),
                 "stage": current.failed_layer, "field": "spec"}
        return {"error": error}
    spec, error = generator.edit_and_validate(req.instruction, req.spec, req.panel_class, on_stage=on_stage)
    diff = specdiff.diff_specs(req.spec, spec) if spec else None
    _audit_generated("edit", req.spec.get("asset_id"), req.instruction, spec, error, started,
                     {"changes": diff["summary"] if diff else None})
    if error:
        return {"error": error}
    return {"spec": spec, "diff": diff, "meta": {"seconds": round(time.time() - started, 2)}}


@app.post("/edit")
def edit(req: EditRequest, request: Request):
    limited = _rate_limited(request)
    return {"error": limited} if limited else _edit(req)


@app.post("/edit/stream")
def edit_stream(req: EditRequest, request: Request):
    limited = _rate_limited(request)
    if limited:
        return _stream(lambda on_stage: {"error": limited})
    return _stream(lambda on_stage: _edit(req, on_stage))


# ------------------------------------------------------------------ alarms

@app.get("/alarms/{asset_id:path}/{alarm_id}/screen")
def alarm_screen(asset_id: str, alarm_id: str):
    """The deterministic troubleshooting screen for one alarm (no LLM)."""
    try:
        ctx = context_store.get_context(asset_id)
        return {"spec": troubleshoot.build_alarm_screen(ctx, alarm_id)}
    except context_store.ContextNotFoundError as e:
        return {"error": {"message": str(e), "stage": "context", "field": "asset_id"}}
    except KeyError as e:
        return {"error": {"message": str(e).strip("'\""), "stage": "whitelist", "field": "alarm_id"}}


@app.post("/alarms/{asset_id:path}/{alarm_id}/ack")
def acknowledge(asset_id: str, alarm_id: str):
    """
    Operator acknowledgement. Recorded in ScreenForge's log only; nothing is
    written to the machine, and the alarm stays active until its condition clears.
    """
    try:
        context_store.get_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if not alarms.acknowledge(asset_id, alarm_id):
        return {"acked": False, "reason": f"{alarm_id} is not active on {asset_id}"}
    store.log_event("alarm_acked", asset_id, alarm_id=alarm_id)
    return {"acked": True}


@app.get("/alarms/{asset_id:path}")
def alarm_states(asset_id: str):
    try:
        return alarms.snapshot(context_store.get_context(asset_id))
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ------------------------------------------------------------ screen library

class SaveScreenRequest(BaseModel):
    spec: dict


@app.post("/screens")
def save_screen(req: SaveScreenRequest):
    """Keep a screen. Only valid specs are saved -- the library never holds a broken screen."""
    result = validator.validate_spec(req.spec)
    if not result.valid:
        return {"error": {"message": "; ".join(result.errors), "stage": result.failed_layer, "field": "spec"}}
    saved = store.save_screen(req.spec)
    store.log_event("screen_saved", req.spec["asset_id"], screen_id=req.spec["screen_id"], title=req.spec["title"])
    return {"screen": saved}


@app.get("/screens")
def list_screens(asset_id: str | None = None):
    return store.list_screens(asset_id)


@app.get("/screens/{screen_id}")
def get_screen(screen_id: str):
    saved = store.get_screen(screen_id)
    if saved is None:
        raise HTTPException(status_code=404, detail=f"No saved screen {screen_id}")
    # A saved screen may predate a machine change: report, never repair.
    saved["reconcile"] = reconciler.reconcile(saved["spec"]) \
        if saved["asset_id"] in context_store.list_asset_ids() else None
    return saved


@app.delete("/screens/{screen_id}")
def delete_screen(screen_id: str):
    if not store.delete_screen(screen_id):
        raise HTTPException(status_code=404, detail=f"No saved screen {screen_id}")
    store.log_event("screen_deleted", None, screen_id=screen_id)
    return {"deleted": True}


@app.get("/log")
def event_log(limit: int = 100, asset_id: str | None = None, kind: str | None = None):
    kinds = [k.strip() for k in kind.split(",")] if kind else None
    return store.recent_events(min(max(limit, 1), 500), asset_id, kinds)


# --------------------------------------------------------------- simulator

class FaultRequest(BaseModel):
    asset_id: str
    tag: str
    value: float | bool
    seconds: float = 20.0


@app.post("/sim/fault")
def inject_fault(req: FaultRequest):
    """
    Demo only, simulator mode only: hold a simulated tag at a value. In live
    mode the plant is a separate process and faults go to its own control
    port -- ScreenForge has no path that changes a value on a real source.
    """
    if acquisition.tag_source_mode() != "sim":
        return {"error": {"message": "Fault injection is only available with the built-in simulator. "
                                     "Use the plant simulator's control port in live mode.",
                          "stage": "request", "field": None}}
    try:
        ctx = context_store.get_context(req.asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if req.tag not in {t["name"] for t in ctx["tags"]}:
        return {"error": {"message": f"{req.tag} is not a tag on {req.asset_id}", "stage": "whitelist", "field": "tag"}}
    tag_simulator.inject_fault(req.asset_id, req.tag, req.value, min(max(req.seconds, 1), 120))
    return {"injected": True}
