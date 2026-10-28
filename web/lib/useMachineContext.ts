// The machine context for an asset: GET /context/{asset_id} when /api is up,
// otherwise the frozen fixture. The fixture is used immediately so a screen never
// waits on a slow connection failure. Call refresh() when /tags reports a
// context_version this hook hasn't loaded yet (a runtime context bump or reset).

import { useCallback, useEffect, useState } from "react";
import { fetchContext } from "./api";
import { FIXTURE_CONTEXTS } from "./contracts";
import type { MachineContext } from "./spec";

export type ContextSource = "api" | "fixture";

export function useMachineContext(assetId: string) {
  // Newest context loaded from /api, per asset.
  const [latest, setLatest] = useState<Record<string, MachineContext>>({});
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchContext(assetId).then(
      (fresh) => {
        if (cancelled) return;
        setLatest((prev) => {
          const current = prev[assetId];
          // Keep the same object for the same version, so live tag polling doesn't restart.
          return current && current.context_version === fresh.context_version ? prev : { ...prev, [assetId]: fresh };
        });
      },
      () => {
        // /api unreachable: the fixture below stays in use.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assetId, refreshes]);

  const refresh = useCallback(() => setRefreshes((n) => n + 1), []);

  const fixture = FIXTURE_CONTEXTS[assetId] ?? null;
  const context = latest[assetId] ?? fixture;
  const source: ContextSource | null = latest[assetId] ? "api" : fixture ? "fixture" : null;
  return { context, source, refresh };
}
