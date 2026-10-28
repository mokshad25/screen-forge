// TypeScript mirror of contracts/screen-spec.schema.json and
// contracts/machine-context.schema.json (v2). If these and the schemas
// disagree, the schemas win.

export type PanelClass = "small" | "medium" | "large";
export type SizeHint = "compact" | "medium" | "wide";
export type ComponentType =
  | "alarm_banner"
  | "status_indicator"
  | "gauge"
  | "numeric_readout"
  | "trend"
  | "multi_trend"
  | "nav_tile"
  | "comms_health";

export interface SpecComponent {
  id: string;
  type: ComponentType;
  bind_tag?: string;
  bind_tags?: string[];
  bind_alarms?: string[];
  bind_device?: string;
  bind_asset?: string;
  priority: number;
  size_hint: SizeHint;
  min_panel?: PanelClass;
}

export type OriginKind = "prompt" | "edit" | "alarm" | "regenerate" | "library";

export interface ScreenSpec {
  screen_id: string;
  title: string;
  asset_id: string;
  context_version: string;
  origin?: { kind: OriginKind; alarm_id?: string; instruction?: string };
  components: SpecComponent[];
  permissions: { mode: "read_only" };
}

export interface TagDef {
  name: string;
  type: "bool" | "analog";
  unit?: string;
  access: "read" | "write";
  description?: string;
  range?: { low: number; high: number };
  source?: { protocol: "opcua" | "modbus" | "connection"; device?: string; address: string; scale?: number };
}

export type AlarmPriority = "Critical" | "High" | "Warning";

export interface AlarmDef {
  id: string;
  desc: string;
  priority: AlarmPriority;
  tag: string;
  condition: { op: ">" | ">=" | "<" | "<=" | "==" | "!="; value: number | boolean };
  related_tags?: string[];
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
  aliases?: string[];
  tags: TagDef[];
  io: Record<string, string[] | undefined>;
  alarms: AlarmDef[];
  comms: CommsDef[];
}

export type TagValue = boolean | number | null;
export type Quality = "good" | "bad" | "n/a";

export interface AlarmState {
  active: boolean;
  since: number | null;
  acked: boolean;
  quality: string;
  priority: AlarmPriority;
  desc: string;
  tag: string;
}

/** GET /tags/{asset_id}, and the payload of a "tags" event on /events. */
export interface TagsSnapshot {
  asset_id: string;
  context_version: string;
  timestamp: number;
  source: "sim" | "live";
  tags: Record<string, TagValue>;
  quality: Record<string, Quality>;
  alarms: Record<string, boolean>;
  alarm_states: Record<string, AlarmState>;
}

/** An "alarm" event on /events. A raised alarm carries its troubleshooting screen. */
export interface AlarmEvent {
  asset_id: string;
  alarm_id: string;
  event: "raised" | "cleared";
  priority: AlarmPriority;
  desc: string;
  tag: string;
  value: TagValue;
  ts: number;
  screen?: ScreenSpec;
}

export interface ApiError {
  message: string;
  stage?: string;
  field?: string | null;
}

export interface SpecDiff {
  added: string[];
  removed: string[];
  changed: { component: string; changes: string[] }[];
  summary: string[];
  unchanged: boolean;
}

export type StageName = "intent" | "context" | "llm" | "schema" | "whitelist" | "read_only";
export type StageStatus = "running" | "ok" | "failed" | "stopped";

export interface StageEvent {
  stage: StageName;
  status: StageStatus;
  attempt?: number;
  seconds?: number;
  errors?: string[];
}

export type GenerateResult =
  | { spec: ScreenSpec; diff?: SpecDiff; meta?: { seconds: number } }
  | { error: ApiError };

export interface AssetSummary {
  asset_id: string;
  name: string;
  hierarchy: string[];
  context_version: string;
  origin: string;
  tag_count: number;
  active_alarms: { id: string; priority: AlarmPriority; desc: string; acked: boolean }[];
}

export interface Health {
  status: string;
  version: string;
  known_assets: string[];
  tag_source: { mode: "sim" | "live"; running: boolean; links: { device: string; up: boolean; error: string | null }[] };
  llm: { configured: boolean; provider?: string; model?: string };
}

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

export interface ReconcileReport {
  asset_id: string;
  spec_context_version: string;
  current_context_version: string;
  stale: boolean;
  changes: ContextChanges | null;
  broken_bindings: { component_id: string; component_type: string; field: string; value: string; reason: string }[];
  still_valid: boolean;
  errors: string[];
}

export interface SavedScreenSummary {
  screen_id: string;
  title: string;
  asset_id: string;
  context_version: string;
  origin_kind: string;
  saved_at: number;
}

export interface LogEntry {
  id: number;
  ts: number;
  kind: string;
  asset_id: string | null;
  [key: string]: unknown;
}
