import { activeAlarmsOnTag, SEVERITY_COLOR, worstSeverity } from "@/lib/severity";
import { CellFrame } from "./CellFrame";
import type { RegistryProps } from "./types";

export function CommsHealth({ component, context, live }: RegistryProps) {
  // The golden spec binds a comms device by name; a health tag binding is also understood.
  const device =
    component.bind_device !== undefined
      ? context.comms.find((c) => c.device === component.bind_device)
      : context.comms.find((c) => c.health_tag === component.bind_tag);
  const healthTag = device?.health_tag ?? component.bind_tag ?? "";
  const raw = live.snapshot?.tags[healthTag];
  const online = typeof raw === "boolean" ? raw : typeof raw === "number" ? raw > 0 : null;
  const severity = worstSeverity(activeAlarmsOnTag(context, live.snapshot, healthTag));
  const mark = severity ? SEVERITY_COLOR[severity] : "var(--neutral-fill)";

  let label = "--";
  if (online !== null) label = online ? "Online" : "Offline";

  return (
    <CellFrame
      title={(device?.device ?? healthTag).replaceAll("_", " ")}
      binding={device ? `${device.device} · ${healthTag}` : healthTag}
      severity={severity}
      badge={device?.protocol}
    >
      <div className="flex flex-1 flex-col justify-center gap-3">
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="size-9 shrink-0 rounded-full border-4"
            style={{ borderColor: mark, background: online ? mark : "transparent" }}
          />
          <span
            className="numeral text-4xl font-bold uppercase leading-none tracking-tight"
            style={{ color: severity ? mark : "var(--text)" }}
          >
            {label}
          </span>
        </div>
        {device && <p className="numeral truncate text-xs text-faint">{device.endpoint}</p>}
      </div>
    </CellFrame>
  );
}
