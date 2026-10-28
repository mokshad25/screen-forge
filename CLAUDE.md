# ScreenForge

Runtime HMI screen generator. An operator types or speaks a request; the system
produces a validated JSON screen specification and renders it responsively.
Maintained by Mokshad Kanaujia.

## Non-negotiable invariants

1. The LLM outputs ONLY a JSON screen specification conforming to
   contracts/screen-spec.schema.json. It never outputs HTML, JSX, CSS, inline
   styles, or pixel coordinates.
2. The screen specification contains NO position, coordinate, width, height,
   colour or font fields. Components carry `priority`, `size_hint` and optional
   `min_panel` only. Layout is computed by the renderer.
3. Validation never auto-repairs an invalid specification. It returns an
   explicit structured error. Silent repair is forbidden.
4. Every bound tag or alarm id must exist in that asset's machine context. The
   whitelist is derived from the machine context at request time, never
   hand-maintained.
5. Read-only. No component may write to a tag. `permissions.mode` is always
   "read_only". There is no code path from the API to a write on any device.
6. Alarm-triggered screens are built deterministically, with no LLM in the
   loop. During an upset the operator never waits on a model.

## Contracts

Files under contracts/ are versioned. A breaking change bumps the schema's
`$id` version and updates api/ and web/ in the same commit, with tests.

## Panel classes
- small (7"): priority 1-3, one column, hides components with min_panel: medium
- medium (10"): priority 1-6, two columns
- large (15"+): everything

## Style
- Small, reviewable commits. One concern per commit.
- No new dependencies without a one-line reason in the commit message.
- Prefer boring, explicit code.
