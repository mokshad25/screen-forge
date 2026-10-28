// Component registry: the fixed vocabulary a screen spec can be composed from.
// Keys match the `type` enum in contracts/screen-spec.schema.json exactly.

import type { ComponentType as ReactComponentType } from "react";
import type { ComponentType } from "@/lib/spec";
import { AlarmBanner } from "./AlarmBanner";
import { CommsHealth } from "./CommsHealth";
import { Gauge } from "./Gauge";
import { NavTile } from "./NavTile";
import { StatusIndicator } from "./StatusIndicator";
import { Trend } from "./Trend";
import type { RegistryProps } from "./types";

export interface RegistryEntry {
  label: string;
  Component: ReactComponentType<RegistryProps>;
  /** Size to content instead of the size_hint cell height (the alarm banner). */
  fitContent?: boolean;
  /** Minimum height in px for a tall cell, when the default is not enough. */
  tallMinHeight?: number;
}

export const REGISTRY: Record<ComponentType, RegistryEntry> = {
  alarm_banner: { label: "Alarm banner", Component: AlarmBanner, fitContent: true },
  status_indicator: { label: "Status indicator", Component: StatusIndicator },
  gauge: { label: "Gauge", Component: Gauge },
  trend: { label: "Trend", Component: Trend, tallMinHeight: 300 },
  comms_health: { label: "Comms health", Component: CommsHealth },
  nav_tile: { label: "Navigation tile", Component: NavTile },
};

export function lookupComponent(type: string): RegistryEntry | undefined {
  return Object.hasOwn(REGISTRY, type) ? REGISTRY[type as ComponentType] : undefined;
}
