import { FIXTURE_CONTEXTS } from "@/lib/contracts";
import { CellFrame } from "./CellFrame";
import type { RegistryProps } from "./types";

/** A drill-down tile to another asset (bind_asset), not a live value. */
export function NavTile({ component, onNavigate }: RegistryProps) {
  const assetId = component.bind_asset ?? "";
  const target = FIXTURE_CONTEXTS[assetId];
  const name = target?.asset_hierarchy.at(-1) ?? assetId;

  return (
    <CellFrame title={name} binding={assetId} severity={null}>
      <div className="flex flex-1 items-end justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-muted">{target ? target.asset_hierarchy.join(" › ") : assetId}</p>
        <button
          type="button"
          disabled={!onNavigate}
          onClick={() => onNavigate?.(component)}
          className="shrink-0 rounded-md border border-cell-border px-3 py-1.5 text-sm font-semibold text-text hover:bg-track disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open ›
        </button>
      </div>
    </CellFrame>
  );
}
