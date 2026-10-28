// TypeScript mirror of the contracts: contracts/screen-spec.schema.json and
// contracts/machine-context.schema.json (tag contracts-frozen, plus d4f634e on
// main, which added bind_asset and per-type bindings). If these types and the
// schemas disagree, the schemas win.

export type PanelClass = "small" | "medium" | "large";
export type SizeHint = "compact" | "medium" | "wide";
export type ComponentType =
  | "alarm_banner"
  | "status_indicator"
  | "gauge"
  | "trend"
  | "nav_tile"
  | "comms_health";

/**
 * Bindings per type (schema, d4f634e): alarm_banner -> bind_alarms,
 * comms_health -> bind_device, nav_tile -> bind_asset, status_indicator /
 * gauge / trend -> bind_tag. The renderer refuses to draw a component whose
 * binding is missing; it never guesses one.
 */
export interface SpecComponent {
  id: string;
  type: ComponentType;
  bind_tag?: string;
  bind_alarms?: string[];
  bind_device?: string;
  bind_asset?: string;
  priority: number;
  size_hint: SizeHint;
  min_panel?: PanelClass;
}

export interface ScreenSpec {
  screen_id: string;
  title: string;
  asset_id: string;
  context_version: string;
  components: SpecComponent[];
  permissions: { mode: "read_only" };
}

export interface TagDef {
  name: string;
  type: "bool" | "analog";
  unit?: string;
  access: "read" | "write";
}

export type AlarmPriority = "Critical" | "High" | "Warning";

export interface AlarmDef {
  id: string;
  desc: string;
  priority: AlarmPriority;
  tag: string;
}

export interface CommsDef {
  device: string;
  protocol: string;
  endpoint: string;
  health_tag: string;
}

export interface MachineContext {
  asset_id: string;
  context_version: string;
  asset_hierarchy: string[];
  tags: TagDef[];
  io: { digital_in?: string[]; digital_out?: string[]; analog_in?: string[]; analog_out?: string[] };
  alarms: AlarmDef[];
  comms: CommsDef[];
}

export type TagValue = boolean | number;

/**
 * Response body of GET /tags/{asset_id}. The contract only says "live values";
 * this is the shape /web reads (see web/README.md).
 */
export interface TagsSnapshot {
  asset_id: string;
  context_version: string;
  /** ISO-8601 text, or Unix time in seconds (what the /api simulator sends). */
  timestamp: string | number;
  tags: Record<string, TagValue>;
  alarms: Record<string, boolean>;
}

/** Error from POST /generate. The contract only says { error }, so stage and field are optional. */
export interface GenerateError {
  message: string;
  stage?: string;
  field?: string | null;
  details?: unknown;
}

export type GenerateResponse =
  | { spec: ScreenSpec; meta?: Record<string, unknown> }
  | { error: GenerateError };

export interface AssetSummary {
  asset_id: string;
  name: string;
  context_version: string;
}

/** What changed between two context versions (api/reconciler.py diff_contexts). */
export interface ContextChanges {
  from_version: string;
  to_version: string;
  tags_added: string[];
  tags_removed: string[];
  alarms_added: string[];
  alarms_removed: string[];
  comms_added: string[];
  comms_removed: string[];
}

export interface BrokenBinding {
  component_id: string;
  component_type: string;
  field: string;
  value: string;
  reason: string;
}

/** Response body of POST /reconcile { spec }. A report only; the spec is never repaired. */
export interface ReconcileReport {
  asset_id: string;
  spec_context_version: string;
  current_context_version: string;
  stale: boolean;
  changes: ContextChanges | null;
  broken_bindings: BrokenBinding[];
  still_valid: boolean;
  errors: string[];
}
