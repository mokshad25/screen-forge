"""
ScreenForge API -- main FastAPI application.

Run this with:
    uvicorn main:app --reload --port 8000

Then visit http://localhost:8000/docs in a browser -- FastAPI auto-generates
an interactive test page for every endpoint, for free. Use it constantly
while building; it's faster than curl for poking at things by hand.
"""

from dotenv import load_dotenv
load_dotenv()  # reads .env into environment variables -- must run before generator.py
                # is imported, since it reads OPENAI_API_KEY at call time, not import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import context_store
import tag_simulator
import generator
import intent
import reconciler

app = FastAPI(title="ScreenForge API")

# CORS = Cross-Origin Resource Sharing. Browsers block a webpage running on
# one address from calling an API running on a *different* address, unless
# the API explicitly says "it's fine, I trust that address." Kostubh's
# Next.js app runs on http://localhost:3000 during development; without this,
# his frontend's fetch() calls to your API would be silently blocked by the
# browser, not your code -- a classic "why is nothing happening" bug.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/tags/{asset_id:path}")
def get_tags(asset_id: str):
    """
    Return live simulated tag values for one asset.

    asset_id uses ':path' in the route because our asset_ids contain dots
    and look like 'line1.conveyorA' or 'plant.utilities.chiller1' -- without
    ':path', FastAPI would still match this fine since dots aren't slashes,
    but ':path' future-proofs it in case an asset_id ever contains a slash.
    """
    try:
        return tag_simulator.get_live_values(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/context/{asset_id:path}")
def get_machine_context(asset_id: str):
    """
    Return the machine context currently in memory for one asset, in exactly
    the shape of contracts/fixtures/context.*.json.

    /web reads contexts from the fixture files today, which is fine until a
    context changes at runtime -- the Phase 4 demo bumps the chiller's
    context_version and adds a tag. Reading it from here instead means /web
    sees that bump, because this returns what the API is actually generating
    and validating against, not what was on disk at build time.
    """
    try:
        return context_store.get_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/context/{asset_id:path}/bump")
def bump_context(asset_id: str):
    """
    The machine change, on demand: add a sensor to a context at runtime and
    move its context_version on. /tags and /context report the new version
    immediately, which is what tells /web the screen is stale.
    """
    try:
        context_store.get_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return reconciler.bump_context(asset_id)


@app.post("/context/{asset_id:path}/reset")
def reset_context(asset_id: str):
    """
    Put a context back to the version on disk, undoing a bump. The demo gets
    rehearsed repeatedly and each run has to start from the original version.
    """
    try:
        context = context_store.reset_context(asset_id)
    except context_store.ContextNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"context_version": context["context_version"], "context": context}


class ReconcileRequest(BaseModel):
    # Typed loosely on purpose. The validate-a-spec panel is somewhere a judge
    # can paste anything, and a bare string or a list would otherwise be
    # rejected by FastAPI as a 422 {"detail": [...]} -- the one error shape
    # /web has to special-case. Anything JSON reaches our own checks below and
    # comes back in the agreed {"error": {...}} shape.
    spec: object = None


@app.post("/reconcile")
def reconcile(req: ReconcileRequest):
    """
    Check an existing screen against the machine context as it stands now:
    what changed since it was built, and whether any of its bindings have
    stopped existing. Reports only -- never repairs the spec.
    """
    spec = req.spec
    if not isinstance(spec, dict):
        return {"error": {
            "message": (
                f"A screen spec must be a JSON object, got "
                f"{type(spec).__name__}. Expected keys: screen_id, title, "
                f"asset_id, context_version, components, permissions."
            ),
            "stage": "schema", "field": "spec"}}
    if "asset_id" not in spec:
        return {"error": {
            "message": (
                "This spec has no asset_id, so there is no machine context to "
                f"check it against (known asset_ids: {context_store.list_asset_ids()})."
            ),
            "stage": "schema", "field": "asset_id"}}
    try:
        return reconciler.reconcile(spec)
    except context_store.ContextNotFoundError as e:
        return {"error": {"message": str(e), "stage": "context", "field": "asset_id"}}


@app.get("/health")
def health():
    """Simple liveness check -- useful during integration to confirm the
    server is even running before debugging anything more complicated."""
    return {"status": "ok", "known_assets": context_store.list_asset_ids()}


class GenerateRequest(BaseModel):
    prompt: str
    # Optional: /web's "detect machine from request" option sends null, and
    # we work the asset out from the prompt (see intent.resolve_asset_id).
    # Without the default, FastAPI would reject that body with a 422 before
    # any of our code runs, and the caller would see FastAPI's {"detail": ...}
    # shape instead of the agreed {"error": {...}} one.
    asset_id: str | None = None
    panel_class: str  # "small" | "medium" | "large"
    # Optional, additive: the context_version the screen being replaced was
    # built against. When /web regenerates a stale screen it passes the old
    # version, and the generator says which signals are new so the new screen
    # reflects the change. Omitting it behaves exactly as before.
    since_context_version: str | None = None
    # Optional, additive: the spec of the screen being replaced. Regeneration
    # is otherwise stateless, so a screen regenerated after a sensor was added
    # can come back with fewer components than the operator can currently see.
    # Passing it keeps what's onscreen and adds the new signal alongside.
    previous_spec: dict | None = None


@app.post("/generate")
def generate(req: GenerateRequest):
    """
    Turn an operator's plain-English prompt into a validated screen spec.
    Returns { "spec": {...} } on success, or { "error": {...} } on failure
    -- this endpoint itself always returns HTTP 200; the caller checks
    which key is present, per the agreed API contract in CLAUDE.md.
    """
    asset_id = (req.asset_id or "").strip() or intent.resolve_asset_id(req.prompt)

    # The read-only gate goes FIRST, before we insist on knowing the machine.
    # "start the motor" doesn't name an asset, and answering it with "which
    # machine did you mean?" buries the real reason we won't do it.
    if intent.control_request(req.prompt):
        return {"error": generator.read_only_error(asset_id, req.prompt)}

    if not asset_id:
        return {
            "error": {
                "message": (
                    "Could not tell which machine this request is about. "
                    f"Name the asset in the request, or pass asset_id "
                    f"(known asset_ids: {context_store.list_asset_ids()})."
                ),
                "stage": "intent",
                "field": "asset_id",
            }
        }

    try:
        context_store.get_context(asset_id)
    except context_store.ContextNotFoundError as e:
        return {"error": {"message": str(e), "stage": "context", "field": "asset_id"}}

    spec, error = generator.generate_and_validate(
        req.prompt, asset_id, req.panel_class,
        since_context_version=req.since_context_version,
        previous_spec=req.previous_spec,
    )
    if error is not None:
        return {"error": error}
    return {"spec": spec}