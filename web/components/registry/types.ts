import type { CellHeight } from "@/lib/layout";
import type { MachineContext, SpecComponent } from "@/lib/spec";
import type { LiveValues } from "@/lib/useLiveTags";

/** Every registry component gets its binding (inside `component`) plus live values. */
export interface RegistryProps {
  component: SpecComponent;
  context: MachineContext;
  live: LiveValues;
  height: CellHeight;
  onNavigate?: (component: SpecComponent) => void;
}
