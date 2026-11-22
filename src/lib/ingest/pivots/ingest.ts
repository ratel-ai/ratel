import { type Pivot, pivotKeys } from "@/lib/ingest/pivots/model";
import { listPivots } from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import { type PivotsFlagOrganization, pivotsEnabled } from "@/lib/platform/pivots-flag";

/**
 * What OTLP ingest reads of a project's pivots (RC-883): the attribute keys
 * its pivots read, so a span row keeps them. Cached per process like the
 * switch (`lib/platform/pivots-flag.ts`): at most one read per project a
 * minute, never one per span. `lib/ingest/otlp/ingest-spans.ts` checks the
 * switch, `FF_PIVOTS`. Owned (ADR-0030): the switch takes the project and,
 * when ingest holds it, its organization, not an ingest flag organization.
 */

export interface PivotIngestDeps {
  enabled: (projectId: string, organization: PivotsFlagOrganization) => Promise<boolean>;
  /** The keys the project's pivots read. May throw: ingest then keeps none. */
  loadKeys: (projectId: string) => Promise<ReadonlySet<string>>;
}

export const PIVOT_KEYS_TTL_MS = 60_000;

/**
 * A cached `loadKeys`. A read in flight is shared; a failed read is not
 * kept, so the next batch tries again.
 */
export function createPivotKeysLookup(
  load: (projectId: string) => Promise<readonly Pick<Pivot, "key" | "presetId">[]>,
  options: { ttlMs?: number; now?: () => number } = {},
): (projectId: string) => Promise<ReadonlySet<string>> {
  const ttlMs = options.ttlMs ?? PIVOT_KEYS_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; keys: Promise<ReadonlySet<string>> }>();
  return (projectId) => {
    const cached = cache.get(projectId);
    if (cached && now() - cached.at < ttlMs) return cached.keys;
    const keys = load(projectId).then(
      (pivots) => new Set(pivots.flatMap((pivot) => pivotKeys(pivot))),
    );
    cache.set(projectId, { at: now(), keys });
    keys.catch(() => {
      if (cache.get(projectId)?.keys === keys) cache.delete(projectId);
    });
    return keys;
  };
}

export const defaultPivotIngestDeps: PivotIngestDeps = {
  enabled: (projectId, organization) => pivotsEnabled(projectId, organization),
  loadKeys: createPivotKeysLookup((projectId) => listPivots(projectId, getDb())),
};
