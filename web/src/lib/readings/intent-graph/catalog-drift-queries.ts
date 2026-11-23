import { and, eq, gte } from "drizzle-orm";
import { getConfig } from "@/config";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { toolUsageCounters } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { type FlagConfig, featureEnabled } from "@/lib/platform/experimental-features";
import { type CatalogDrift, GONE_TOOL_GRACE_DAYS, goneTools } from "./catalog-drift";

/** The facts the gone-tool rule (./catalog-drift.ts) reads, and its switch. */

/**
 * Upstream's `cloud-ranking-catalog-drift` (RC-721), still a rollout flag there. Owned
 * (ADR-0004): here it is the deployment switch, off by default (in the open-source edition also
 * `experimentalFeatures`).
 */
export const CATALOG_DRIFT_SWITCH = "rankingCatalogDrift" as const;

export type CatalogDriftDb = Pick<ReturnType<typeof getDb>, "select" | "selectDistinct">;

/** The catalog's tool ids and the tools called within the grace period: what the rule reads. */
export interface CatalogDriftFacts {
  catalogToolIds: Set<string>;
  recentlyCalled: Set<string>;
}

export async function loadCatalogDriftFacts(
  projectId: string,
  now: Date = new Date(),
  db: CatalogDriftDb = getDb(),
): Promise<CatalogDriftFacts> {
  const since = new Date(now.getTime() - GONE_TOOL_GRACE_DAYS * 86_400_000);
  const [catalog, recent] = await Promise.all([
    db
      .select({ id: runtimeCatalogEntries.entryId })
      .from(runtimeCatalogEntries)
      .where(
        and(eq(runtimeCatalogEntries.projectId, projectId), eq(runtimeCatalogEntries.kind, "tool")),
      ),
    db
      .selectDistinct({ id: toolUsageCounters.toolId })
      .from(toolUsageCounters)
      .where(
        and(eq(toolUsageCounters.projectId, projectId), gte(toolUsageCounters.lastUsedAt, since)),
      ),
  ]);
  return {
    catalogToolIds: new Set(catalog.map((row) => row.id)),
    recentlyCalled: new Set(recent.map((row) => row.id)),
  };
}

/** Read the facts for one project and apply the rule to `toolIds`. */
export async function loadCatalogDrift(
  projectId: string,
  toolIds: Iterable<string>,
  now: Date = new Date(),
  db: CatalogDriftDb = getDb(),
): Promise<CatalogDrift> {
  const facts = await loadCatalogDriftFacts(projectId, now, db);
  return goneTools(toolIds, facts.catalogToolIds, facts.recentlyCalled);
}

/**
 * Whether the catalog-drift rule applies for whoever asked: the deployment switch without the
 * edition's flags port, the edition's value for this project and caller with it
 * (`featureEnabled`).
 */
export async function catalogDriftEnabledForActor(
  projectId: string,
  actor: string,
  config: FlagConfig = getConfig(),
): Promise<boolean> {
  return featureEnabled(CATALOG_DRIFT_SWITCH, { projectId, actor }, { config });
}
