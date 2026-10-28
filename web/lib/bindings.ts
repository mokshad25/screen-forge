// Defence in depth only: the /api validator is what guarantees bindings, and
// POST /reconcile is what reports bindings broken by a context change. The
// renderer uses this to refuse a component it cannot draw. Nothing is repaired.

import { FIXTURE_CONTEXTS } from "./contracts";
import type { MachineContext, SpecComponent } from "./spec";

export function bindingLabel(component: SpecComponent): string {
  return (
    component.bind_alarms?.join(", ") ?? component.bind_device ?? component.bind_asset ?? component.bind_tag ?? "(unbound)"
  );
}

export function bindingProblem(component: SpecComponent, context: MachineContext): string | null {
  const version = context.context_version;
  switch (component.type) {
    case "alarm_banner": {
      if (!component.bind_alarms) return "alarm_banner has no bind_alarms";
      const missing = component.bind_alarms.filter((id) => !context.alarms.some((a) => a.id === id));
      return missing.length > 0 ? `${missing.join(", ")} not found in ${version}` : null;
    }
    case "comms_health": {
      if (component.bind_device !== undefined) {
        return context.comms.some((c) => c.device === component.bind_device)
          ? null
          : `device ${component.bind_device} not found in ${version}`;
      }
      if (component.bind_tag !== undefined) {
        return context.comms.some((c) => c.health_tag === component.bind_tag)
          ? null
          : `${component.bind_tag} is not a comms health tag in ${version}`;
      }
      return "comms_health has no bind_device";
    }
    case "nav_tile": {
      if (component.bind_asset === undefined) return "nav_tile has no bind_asset";
      return FIXTURE_CONTEXTS[component.bind_asset] ? null : `asset ${component.bind_asset} has no machine context`;
    }
    default: {
      if (component.bind_tag === undefined) return `${component.type} has no bind_tag`;
      return context.tags.some((t) => t.name === component.bind_tag) ? null : `${component.bind_tag} not found in ${version}`;
    }
  }
}
