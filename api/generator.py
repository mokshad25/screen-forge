"""
Spec generator -- turns an operator's plain-English prompt into a validated
screen specification.

Pipeline:
  1. Retrieve the machine context for the requested asset (dropping "io" --
     see note below).
  2. Build a system prompt containing the rules + 3 golden few-shot examples.
  3. Call the LLM using Structured Outputs (strict JSON-schema mode) so the
     SHAPE of the response is almost guaranteed correct. OpenAI is used when
     OPENAI_API_KEY is set; otherwise Groq's OpenAI-compatible API when
     GROQ_API_KEY is set (see llm_provider()).
  4. Strip null binding fields (strict mode requires every field present,
     so the model emits bind_tag/bind_alarms/bind_device/bind_asset every
     time, three of them null).
  5. Run the cleaned candidate through the real validator (the same one
     used everywhere else -- this function never trusts the LLM's output
     on its own).
  6. If invalid, retry ONCE, appending the validator's error to the prompt
     so the model can see exactly what it got wrong.
  7. If still invalid, give up and return the error. Never return a spec
     that didn't pass validation, no matter how close it looks.

Why "io" is deliberately left out of what the model sees: none of the six
component types bind to raw I/O signals (Emergency_Stop, Door_Switch, etc)
-- only to tags, alarms, and comms devices. Including "io" would only give
the model more surface area to hallucinate an invalid binding from, for
zero benefit.
"""

import json
import os
from pathlib import Path

from openai import OpenAI

import context_store
import intent
import validator

MODEL_NAME = "gpt-4o-mini"

# Groq and xAI both serve an OpenAI-compatible API, so the same client and the
# same strict json_schema request work against all three -- only the base_url,
# the key and the model name change. gpt-oss-120b accepts GENERATION_SCHEMA in
# strict mode.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_MODEL_NAME = "openai/gpt-oss-120b"
XAI_BASE_URL = "https://api.x.ai/v1"
XAI_MODEL_NAME = "grok-4.1-fast-non-reasoning"

# provider -> (env var holding the key, base_url or None for OpenAI's own,
# default model, default reasoning_effort). Order matters: the first provider
# with a key set wins.
#
# reasoning_effort is per-provider because it is not universally supported:
# the gpt-oss models on Groq are reasoning models and accept it, gpt-4o-mini
# does not. "low" is the measured default for Groq -- it cuts reasoning from
# ~426 tokens to ~34 per call with no loss of reliability (still 20/20), and
# fewer tokens is what buys headroom against the tokens-per-minute limit.
PROVIDERS: dict[str, tuple[str, str | None, str, str | None]] = {
    "openai": ("OPENAI_API_KEY", None, MODEL_NAME, None),
    "groq": ("GROQ_API_KEY", GROQ_BASE_URL, GROQ_MODEL_NAME, "low"),
    "xai": ("XAI_API_KEY", XAI_BASE_URL, XAI_MODEL_NAME, None),
}

# Both knobs are overridable from api/.env, so a timing experiment is a
# one-line change rather than an edit to this file:
#   SCREENFORGE_MODEL=openai/gpt-oss-20b   -- swap the model
#   SCREENFORGE_REASONING_EFFORT=medium    -- override the provider default
MODEL_ENV_VAR = "SCREENFORGE_MODEL"
REASONING_EFFORT_ENV_VAR = "SCREENFORGE_REASONING_EFFORT"

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "contracts" / "fixtures"
SCREEN_SPEC_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "contracts" / "screen-spec.schema.json"

_GOLDEN_FIXTURE_NAMES = [
    "spec.golden.status-alarms.json",
    "spec.golden.trend.json",
    "spec.golden.comms.json",
]

COMPONENT_TYPES = ["alarm_banner", "status_indicator", "gauge", "trend", "nav_tile", "comms_health"]

# A strict-mode-compatible schema. Every property must be listed in
# "required" (that's a Structured Outputs requirement, not a design choice)
# -- optional-in-spirit fields are made "nullable" instead of actually
# optional. This is NOT the same file as contracts/screen-spec.schema.json;
# that one enforces the real business rules (exactly one binding per type)
# via if/then, which strict mode does not support. This schema only has to
# get the SHAPE right; the real schema + validator.py enforce correctness.
GENERATION_SCHEMA = {
    "type": "object",
    "required": ["screen_id", "title", "asset_id", "context_version", "components", "permissions"],
    "additionalProperties": False,
    "properties": {
        "screen_id": {"type": "string"},
        "title": {"type": "string"},
        "asset_id": {"type": "string"},
        "context_version": {"type": "string"},
        "components": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "type", "priority", "size_hint", "min_panel",
                             "bind_tag", "bind_alarms", "bind_device", "bind_asset"],
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string"},
                    "type": {"type": "string", "enum": COMPONENT_TYPES},
                    "priority": {"type": "integer"},
                    "size_hint": {"type": "string", "enum": ["compact", "medium", "wide"]},
                    "min_panel": {"type": ["string", "null"], "enum": ["small", "medium", "large", None]},
                    "bind_tag": {"type": ["string", "null"]},
                    "bind_alarms": {"type": ["array", "null"], "items": {"type": "string"}},
                    "bind_device": {"type": ["string", "null"]},
                    "bind_asset": {"type": ["string", "null"]},
                },
            },
        },
        "permissions": {
            "type": "object",
            "required": ["mode"],
            "additionalProperties": False,
            "properties": {"mode": {"type": "string", "enum": ["read_only"]}},
        },
    },
}


def _load_golden_examples() -> list[dict]:
    examples = []
    for name in _GOLDEN_FIXTURE_NAMES:
        with open(FIXTURES_DIR / name) as f:
            examples.append(json.load(f))
    return examples


def _context_for_prompt(asset_id: str) -> dict:
    """The machine context, with 'io' deliberately dropped -- see module docstring."""
    ctx = context_store.get_context(asset_id)
    return {k: v for k, v in ctx.items() if k != "io"}


def _build_system_prompt() -> str:
    examples_text = "\n\n".join(
        f"Example {i+1}:\n{json.dumps(ex, indent=2)}"
        for i, ex in enumerate(_load_golden_examples())
    )
    return f"""You generate HMI screen specifications for an industrial operator interface.

RULES (violating any of these makes the spec unusable):
- Output ONLY a JSON object. No prose, no markdown code fences, no explanation.
- Every component's binding fields (bind_tag, bind_alarms, bind_device, bind_asset) must all
  be present in your output, but exactly ONE of them should be non-null for each component.
  Set the other three to null.
- alarm_banner components must use bind_alarms (a list of alarm ids). Never bind_tag.
- comms_health components must use bind_device (a device name from the context's comms list).
- nav_tile components must use bind_asset. You will rarely need this component.
- status_indicator, gauge, and trend components must use bind_tag (a single tag name).
- Every tag name, alarm id, or device name you reference MUST come from the machine context
  you are given. Never invent one, even if a plausible-sounding name would fit the request.
- permissions.mode must always be "read_only".
- Never include position, coordinate, width, height, color, or font fields. Only priority,
  size_hint, and min_panel control layout, and the renderer computes layout from those --
  not you.
- priority: 1 is most important/urgent. If the request implies urgency (an alarm, a fault),
  that component should get priority 1.
- size_hint: "wide" means the component always takes a full row to itself, on every panel
  size. "compact" means it wants minimal space. "medium" is the default for most components.
- min_panel: set to "medium" only if the component genuinely needs more room than a 7" panel
  offers (e.g. a trend chart). Otherwise use "small" or leave it appropriate for a compact view.
- context_version in your output must exactly match the context_version given to you below.
- screen_id should be a short unique-looking string, e.g. "gen_<short-random-string>".

Here are 3 correct, real examples showing exactly the shape and style expected:

{examples_text}
"""


def _strip_nulls(spec: dict) -> dict:
    """
    Remove null-valued binding fields from every component, so the cleaned
    spec matches the real contracts/screen-spec.schema.json shape (which
    does not expect the other three binding fields to be present at all,
    let alone null).
    """
    cleaned = dict(spec)
    cleaned["components"] = [
        {k: v for k, v in comp.items() if v is not None}
        for comp in spec.get("components", [])
    ]
    return cleaned


def _active_provider() -> str:
    """The first provider in PROVIDERS whose key is set."""
    for provider, (env_var, _base_url, _model, _effort) in PROVIDERS.items():
        if os.environ.get(env_var):
            return provider

    keys = ", ".join(env_var for env_var, _b, _m, _e in PROVIDERS.values())
    raise RuntimeError(f"No LLM key set: put one of {keys} in api/.env")


def reasoning_effort() -> str | None:
    """
    The reasoning_effort for the next call: SCREENFORGE_REASONING_EFFORT if
    set, else the active provider's default, else None (knob not sent at all).
    """
    override = os.environ.get(REASONING_EFFORT_ENV_VAR)
    if override:
        return override
    try:
        return PROVIDERS[_active_provider()][3]
    except RuntimeError:
        return None


def llm_provider() -> tuple[str, str]:
    """
    Which (provider, model) the next LLM call will use, read at call time.
    SCREENFORGE_MODEL overrides that provider's default model.
    """
    provider = _active_provider()
    _env_var, _base_url, default_model, _effort = PROVIDERS[provider]
    return provider, os.environ.get(MODEL_ENV_VAR) or default_model


def _call_llm(system_prompt: str, user_prompt: str) -> dict:
    """
    Real LLM call using Structured Outputs, against whichever provider has a
    key set (see llm_provider()).
    """
    provider, model = llm_provider()
    env_var, base_url, _default_model, _default_effort = PROVIDERS[provider]

    client = OpenAI(api_key=os.environ[env_var], base_url=base_url)

    extra = {}
    effort = reasoning_effort()
    if effort:
        extra["reasoning_effort"] = effort

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "screen_specification",
                "schema": GENERATION_SCHEMA,
                "strict": True,
            },
        },
        **extra,
    )
    return json.loads(response.choices[0].message.content)


def read_only_error(asset_id: str | None, prompt: str) -> dict:
    """
    The explanation an operator gets when they ask us to change something.

    Written here in Python, never by the model: invariant 1 says the LLM
    only ever emits spec JSON, so a refusal can't be something it authors.
    Quotes the operator's own request back, and names a few real read tags
    from the asset's context so the answer says what they CAN have, not just
    what they can't.

    asset_id may be None: a control request is refused whether or not we
    worked out which machine it was aimed at, so the refusal has to read
    sensibly without one.
    """
    readable: list[str] = []
    if asset_id:
        try:
            context = context_store.get_context(asset_id)
            readable = [t["name"] for t in context["tags"] if t.get("access") != "write"]
        except context_store.ContextNotFoundError:
            readable = []

    quoted = " ".join((prompt or "").split())
    if len(quoted) > 70:
        quoted = quoted[:67] + "..."

    if asset_id:
        scope = (
            f"Every generated screen is read-only by design: it can display "
            f"{asset_id}, but it cannot start, stop, or change anything on it."
        )
    else:
        scope = (
            "Every generated screen is read-only by design: it can display a "
            "machine, but it cannot start, stop, or change anything on it."
        )

    examples = ", ".join(readable[:3])
    can_show = f" It can show you live values such as {examples}." if examples else ""

    return {
        "message": (
            f"\"{quoted}\" asks to change the machine, and ScreenForge builds "
            f"monitoring screens only. {scope}{can_show}"
        ),
        "stage": "read_only",
        "field": None,
    }


def _describe_binding(component: dict) -> str:
    """'status_indicator(Compressor_RunStatus)' -- how a component reads in a prompt."""
    binding = (
        component.get("bind_tag")
        or component.get("bind_device")
        or component.get("bind_asset")
        or ", ".join(component.get("bind_alarms") or [])
    )
    return f"{component.get('type')}({binding})"


def _keep_what_is_onscreen_note(previous_spec: dict | None, current: dict) -> str:
    """
    A note listing what the operator is already looking at.

    Regeneration is otherwise stateless: the model composes a fresh screen
    from the prompt, so a screen regenerated after a sensor was added can
    quietly come back with FEWER components than before. From the operator's
    side that reads as losing data at the exact moment they were told the
    machine gained some.
    """
    if not previous_spec:
        return ""

    known_tags = {t["name"] for t in current["tags"]}
    known_alarms = {a["id"] for a in current["alarms"]}
    known_devices = {c["device"] for c in current["comms"]}

    still_there = []
    for component in previous_spec.get("components", []):
        binding = (
            component.get("bind_tag")
            or component.get("bind_device")
            or component.get("bind_asset")
            or ""
        )
        alarms = component.get("bind_alarms") or []
        if (
            binding in known_tags
            or binding in known_devices
            or binding in context_store.list_asset_ids()
            or (alarms and all(a in known_alarms for a in alarms))
        ):
            still_there.append(_describe_binding(component))

    if not still_there:
        return ""

    return (
        f"\nThe operator is already looking at a screen showing: "
        f"{'; '.join(still_there)}. Keep all of these, and add the new signal "
        f"alongside them. The screen must not come back with fewer components "
        f"than the operator can currently see."
    )


def _whats_new_note(asset_id: str, since_context_version: str | None,
                    previous_spec: dict | None = None) -> str:
    """
    A note naming what appeared on this machine since the version the operator
    last saw, or "" when nothing did.

    The model is already shown the full current context, so a newly added tag
    is never missing from what it knows -- it just has no reason to prefer it.
    "Chiller overview" describes the same screen whether or not a vibration
    sensor was fitted this morning. This says which signals are new, so a
    regenerated screen can reflect the change the operator is being told about.
    """
    if not since_context_version:
        return ""

    current = context_store.get_context(asset_id)
    if since_context_version == current["context_version"]:
        return ""

    previous = context_store.get_version(asset_id, since_context_version)
    if previous is None:
        return ""

    import reconciler  # local import: reconciler imports validator, not this

    changes = reconciler.diff_contexts(previous, current)
    added = changes["tags_added"] + changes["alarms_added"] + changes["comms_added"]
    removed = changes["tags_removed"] + changes["alarms_removed"] + changes["comms_removed"]
    if not added and not removed:
        return ""

    units = {t["name"]: t.get("unit") for t in current["tags"]}
    described = ", ".join(
        f"{name} ({units[name]})" if units.get(name) else name for name in added
    )

    lines = [f"\n\nThis machine changed since the operator last saw this screen "
             f"({since_context_version} -> {current['context_version']})."]
    if added:
        lines.append(
            f"Newly available: {described}. The operator is being shown this change, "
            f"so include the new signal(s) in the screen unless the request is "
            f"explicitly about something else. The operator is being told about "
            f"this change right now, so the new signal must be visible even on "
            f'the 7" panel, which shows only priority 1-3 and hides min_panel '
            f'"medium": give each new signal min_panel "small" and a priority of '
            f"2 or 3, renumbering the other components downward to make room. "
            f"An alarm_banner always keeps priority 1."
        )
    if removed:
        lines.append(f"No longer available, never bind these: {', '.join(removed)}.")

    lines.append(_keep_what_is_onscreen_note(previous_spec, current))
    return "\n".join(line for line in lines if line)


def generate_and_validate(prompt: str, asset_id: str, panel_class: str, llm_fn=_call_llm,
                          since_context_version: str | None = None,
                          previous_spec: dict | None = None) -> tuple[dict | None, dict | None]:
    """
    Full pipeline: refuse control requests, then call the LLM, clean it,
    validate it, retry once on failure with the error appended, then give up.

    llm_fn is injectable so tests can run this whole pipeline without a
    real network call -- production code should never need to pass it.

    Returns (spec, None) on success, or (None, error_dict) on failure,
    where error_dict matches the agreed /generate error shape:
        { "message": str, "stage": str, "field": str | None }
    """
    # The read-only gate runs BEFORE the LLM: a request to change the machine
    # is answered with an explanation, not with a quiet monitoring screen
    # that ignores what was actually asked. No tokens spent, no latency.
    if intent.control_request(prompt):
        return None, read_only_error(asset_id, prompt)

    ctx = _context_for_prompt(asset_id)
    system_prompt = _build_system_prompt()
    # The operator's words go in verbatim. What changed on the machine is
    # added as separate context, never spliced into their request.
    base_user_prompt = (
        f"Operator request: \"{prompt}\"\n"
        f"Target panel class: {panel_class}\n"
        f"Machine context:\n{json.dumps(ctx, indent=2)}"
        f"{_whats_new_note(asset_id, since_context_version, previous_spec)}"
    )

    for attempt in range(2):  # first attempt + one retry
        user_prompt = base_user_prompt
        try:
            raw = llm_fn(system_prompt, user_prompt)
        except Exception as e:
            return None, {"message": f"LLM call failed: {e}", "stage": "llm", "field": None}

        cleaned = _strip_nulls(raw)
        result = validator.validate_spec(cleaned)

        if result.valid:
            return cleaned, None

        if attempt == 0:
            # Retry once, appending the validator's own error text so the
            # model can see exactly what it got wrong.
            base_user_prompt = (
                base_user_prompt
                + "\n\nYour previous attempt was rejected for this reason:\n"
                + "\n".join(result.errors)
                + "\nFix this specific problem and try again."
            )
            continue

        # Second attempt also failed -- give up honestly.
        return None, {
            "message": "; ".join(result.errors) if result.errors else "Generated spec failed validation.",
            "stage": result.failed_layer,
            "field": None,
        }

    # Unreachable, but keeps type checkers happy. "llm" rather than "other"
    # because those six stages are the ones web/README.md says /web can
    # render; an unknown stage would leave the progress indicator with no
    # step to mark red.
    return None, {"message": "Unknown generation failure.", "stage": "llm", "field": None}
