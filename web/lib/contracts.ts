// Frozen fixtures from contracts/, imported read-only: the offline fallback
// machine contexts and the golden screens. Plus /web's own pre-generated demo
// screens (web/demo-screens), real /generate output kept as a fallback in case
// live generation fails during the demo.
import chiller from "../../contracts/fixtures/context.chiller.json";
import conveyorA from "../../contracts/fixtures/context.conveyorA.json";
import comms from "../../contracts/fixtures/spec.golden.comms.json";
import statusAlarms from "../../contracts/fixtures/spec.golden.status-alarms.json";
import trend from "../../contracts/fixtures/spec.golden.trend.json";
import chillerOverview from "../demo-screens/chiller1.overview.json";
import conveyorOverview from "../demo-screens/conveyorA.overview.json";
import type { AssetSummary, MachineContext, ScreenSpec } from "./spec";

// TypeScript types JSON imports loosely (string instead of literal unions).
// The shape is guaranteed by contracts/*.schema.json, which every fixture passes;
// the demo screens came out of /api's validator.
const asContext = (json: unknown) => json as MachineContext;
const asSpec = (json: unknown) => json as ScreenSpec;

export const FIXTURE_CONTEXTS: Record<string, MachineContext> = Object.fromEntries(
  [asContext(conveyorA), asContext(chiller)].map((context) => [context.asset_id, context]),
);

export const FIXTURE_ASSETS: AssetSummary[] = Object.values(FIXTURE_CONTEXTS).map((context) => ({
  asset_id: context.asset_id,
  name: context.asset_hierarchy.at(-1) ?? context.asset_id,
  context_version: context.context_version,
}));

export interface GoldenSpec {
  key: string;
  /** Repo-relative path, shown on screen. */
  path: string;
  label: string;
  /** A pre-generated demo screen rather than a contract fixture. */
  fallback: boolean;
  spec: ScreenSpec;
}

export const GOLDEN_SPECS: GoldenSpec[] = [
  {
    key: "status-alarms",
    path: "contracts/fixtures/spec.golden.status-alarms.json",
    label: "Conveyor A · status and alarms",
    fallback: false,
    spec: asSpec(statusAlarms),
  },
  {
    key: "trend",
    path: "contracts/fixtures/spec.golden.trend.json",
    label: "Conveyor A · temperature trend",
    fallback: false,
    spec: asSpec(trend),
  },
  {
    key: "comms",
    path: "contracts/fixtures/spec.golden.comms.json",
    label: "Chiller 1 · connectivity health",
    fallback: false,
    spec: asSpec(comms),
  },
  {
    key: "fallback-conveyor",
    path: "web/demo-screens/conveyorA.overview.json",
    label: "Fallback · Conveyor A overview",
    fallback: true,
    spec: asSpec(conveyorOverview),
  },
  {
    key: "fallback-chiller",
    path: "web/demo-screens/chiller1.overview.json",
    label: "Fallback · Chiller 1 overview",
    fallback: true,
    spec: asSpec(chillerOverview),
  },
];
