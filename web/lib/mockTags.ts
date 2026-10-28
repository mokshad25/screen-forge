// Client-side stand-in for GET /tags/{asset_id}, used only when /api is not
// reachable so /web runs standalone. Produces the TagsSnapshot shape /web
// expects. The real simulator lives in /api.
//
// The contract has no trip limits, so alarms here are simulated as occasional
// excursions that also drive their tag to an abnormal value.

import { clamp, displayRange } from "./format";
import type { AlarmDef, MachineContext, TagDef, TagsSnapshot, TagValue } from "./spec";

const ALARM_CHANCE = 0.01;
const COMMS_DROP_CHANCE = 0.004;
/** Ticks an excursion runs before its alarm shows, so the value has visibly moved first. */
const ALARM_DELAY = 3;

interface Excursion {
  age: number;
  ticksLeft: number;
}

function normalValue(tag: TagDef): TagValue {
  // Run status and health bits are healthy when true; command (write) tags sit idle.
  if (tag.type === "bool") return tag.access !== "write";
  const { min, max } = displayRange(tag);
  return min + (max - min) * 0.45;
}

/** "Low ..." alarms pull their tag down, everything else pushes it up; bool tags drop to false. */
function abnormalValue(tag: TagDef, alarm: AlarmDef): TagValue {
  if (tag.type === "bool") return false;
  const { min, max } = displayRange(tag);
  return /low/i.test(alarm.desc) ? min + (max - min) * 0.08 : min + (max - min) * 0.92;
}

function advance(active: Record<string, Excursion>, keys: string[], chance: number): void {
  for (const key of keys) {
    const excursion = active[key];
    if (excursion) {
      excursion.age += 1;
      excursion.ticksLeft -= 1;
      if (excursion.ticksLeft <= 0) delete active[key];
    } else if (Math.random() < chance) {
      active[key] = { age: 0, ticksLeft: 8 + Math.floor(Math.random() * 10) };
    }
  }
}

export class MockTagSimulator {
  private readonly context: MachineContext;
  private readonly values: Record<string, TagValue> = {};
  private readonly alarmExcursions: Record<string, Excursion> = {};
  private readonly commsDrops: Record<string, Excursion> = {};

  constructor(context: MachineContext) {
    this.context = context;
    for (const tag of context.tags) {
      this.values[tag.name] = normalValue(tag);
    }
  }

  tick(): TagsSnapshot {
    advance(this.alarmExcursions, this.context.alarms.map((a) => a.id), ALARM_CHANCE);
    advance(this.commsDrops, this.context.comms.map((c) => c.health_tag), COMMS_DROP_CHANCE);

    for (const tag of this.context.tags) {
      // Nothing writes in a read-only MVP, so write tags hold their idle value.
      if (tag.access === "write") continue;
      const alarm = this.context.alarms.find((a) => a.tag === tag.name && this.alarmExcursions[a.id]);

      if (tag.type === "bool") {
        this.values[tag.name] = alarm || this.commsDrops[tag.name] ? false : normalValue(tag);
        continue;
      }
      const { min, max } = displayRange(tag);
      const goal = (alarm ? abnormalValue(tag, alarm) : normalValue(tag)) as number;
      const current = this.values[tag.name] as number;
      const noise = (Math.random() - 0.5) * (max - min) * 0.015;
      this.values[tag.name] = clamp(current + (goal - current) * (alarm ? 0.3 : 0.1) + noise, min, max);
    }

    const alarms: Record<string, boolean> = {};
    for (const alarm of this.context.alarms) {
      const excursion = this.alarmExcursions[alarm.id];
      alarms[alarm.id] = excursion !== undefined && excursion.age >= ALARM_DELAY;
    }

    return {
      asset_id: this.context.asset_id,
      context_version: this.context.context_version,
      timestamp: new Date().toISOString(),
      tags: { ...this.values },
      alarms,
    };
  }
}
