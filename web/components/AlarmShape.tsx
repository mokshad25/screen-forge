import type { AlarmPriority } from "@/lib/spec";
import { PRIORITY_COLOR } from "@/lib/format";

// Alarm priority is carried by shape as well as colour (ISA-101), so it
// still reads for a colour-blind operator or on a washed-out panel:
//   Critical: diamond   High: triangle   Warning: square
// The digit inside repeats the priority as text.

const DIGIT: Record<AlarmPriority, string> = { Critical: "1", High: "2", Warning: "3" };

export function AlarmShape({
  priority,
  size = 18,
  active = true,
  acked = false,
  decorative = false,
}: {
  priority: AlarmPriority;
  size?: number;
  active?: boolean;
  acked?: boolean;
  /** Inside a control whose own text already names the alarm: hide from screen readers. */
  decorative?: boolean;
}) {
  const fill = active ? PRIORITY_COLOR[priority] : "transparent";
  const stroke = active ? "var(--ink)" : "var(--ink-faint)";
  const text = active ? "var(--ink)" : "var(--ink-faint)";
  // Unacknowledged alarms blink; acknowledged ones stay solid.
  const blink = active && !acked ? "sf-blink" : undefined;
  let shape;
  if (priority === "Critical") shape = <polygon points="12,1.5 22.5,12 12,22.5 1.5,12" />;
  else if (priority === "High") shape = <polygon points="12,2 22.5,21 1.5,21" />;
  else shape = <rect x="3" y="3" width="18" height="18" />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `${priority} priority${active ? (acked ? ", acknowledged" : ", unacknowledged") : ", inactive"}`}
      className={blink}
    >
      <g fill={fill} stroke={stroke} strokeWidth={1.5} strokeLinejoin="round">
        {shape}
      </g>
      <text x="12" y={priority === "High" ? 18 : 16.2} textAnchor="middle" fontSize="11" fontWeight="700" fill={text}>
        {DIGIT[priority]}
      </text>
    </svg>
  );
}
