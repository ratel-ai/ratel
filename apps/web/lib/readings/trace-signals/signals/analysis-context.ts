import { and, asc, desc, eq, gte, lt, max, sql, sum } from "drizzle-orm";
import { loadCatalogInventory } from "@/lib/ingest/runtime-catalog/inventory";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { toolUsageCounters, traceEvents } from "@/lib/ingest/trace-events/schema";
import { ledgerStartedAt, type SignalsDb } from "@/lib/ledger/closed-turns";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { intentGraphClusters } from "@/lib/readings/intent-graph/schema";
import type { AwaitedFix } from "@/lib/readings/trace-signals/signals/data-fixes";
import { loadOtelFacts } from "@/lib/readings/trace-signals/signals/otel-facts-query";
import type {
  AnalysisContext,
  CatalogEntryFact,
  ClusterFact,
  UsageFact,
} from "@/lib/readings/trace-signals/signals/types";
import { loadPreviousWorkflows } from "@/lib/readings/trace-signals/signals/workflow-previous";
import {
  chooseRunBasis,
  type RunBasisCounts,
} from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * What a signal run reads besides turns: the catalog, the usage counters, the intent
 * graph's clusters, the OpenTelemetry facts, the previous run's workflows and how the
 * window's runs were cut. Every function takes an injectable `db` so the job tests
 * against PGlite.
 *
 * Owned (ADR-0030): the L4 half of upstream's signals ledger module. The closed-turn
 * readers it shares a file with upstream are `lib/ledger/closed-turns.ts`, so the ledger
 * never imports a reading.
 */

const logger = getLogger("trace-signals/analysis-context");

/**
 * Fixed rows since a reading, per awaited fix (`data-fixes.ts`): closed SDK runs with a
 * turn id, closed runs that called a tool, and turn scopes that sent the user's message.
 * Only the fixes asked for are counted.
 */
export async function countFixesSince(
  projectId: string,
  since: Date,
  fixes: readonly AwaitedFix[],
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<Partial<Record<AwaitedFix, number>>> {
  const out: Partial<Record<AwaitedFix, number>> = {};
  if (fixes.includes("turn_ids") || fixes.includes("tool_calls")) {
    const [row] = await db
      .select({
        declared: sql<number>`count(*) filter (where ${traceTurns.turnSource} = 'declared')::int`,
        tools: sql<number>`count(*) filter (where ${traceTurns.invokeCount} > 0)::int`,
      })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.status, "closed"),
          gte(traceTurns.endedAt, since),
        ),
      );
    if (fixes.includes("turn_ids")) out.turn_ids = row?.declared ?? 0;
    if (fixes.includes("tool_calls")) out.tool_calls = row?.tools ?? 0;
  }
  if (fixes.includes("user_messages")) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.type, "turn_start"),
          gte(traceEvents.receivedAt, since),
          sql`coalesce(${traceEvents.payload} ->> 'user_message', '') <> ''`,
        ),
      );
    out.user_messages = row?.n ?? 0;
  }
  return out;
}

/** Catalog entries as the detectors read them, plus the corpus fingerprint. */
export async function loadCatalogFacts(
  projectId: string,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<{ entries: CatalogEntryFact[]; fingerprint: string | null }> {
  const inventory = await loadCatalogInventory(projectId, db);
  return {
    entries: inventory.entries.map((e) => ({
      kind: e.kind,
      entryId: e.entryId,
      name: e.name,
      searchable: e.searchable,
    })),
    fingerprint: inventory.entryCount > 0 ? inventory.fingerprint : null,
  };
}

/** `tool_usage_counters` summed over sources. */
export async function loadUsageFacts(
  projectId: string,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<UsageFact[]> {
  const rows = await db
    .select({
      toolId: toolUsageCounters.toolId,
      calls: sum(toolUsageCounters.calls).mapWith(Number),
      lastUsedAt: max(toolUsageCounters.lastUsedAt),
    })
    .from(toolUsageCounters)
    .where(eq(toolUsageCounters.projectId, projectId))
    .groupBy(toolUsageCounters.toolId);
  return rows.flatMap((r) =>
    r.lastUsedAt ? [{ toolId: r.toolId, calls: r.calls ?? 0, lastUsedAt: r.lastUsedAt }] : [],
  );
}

/**
 * Cluster sizes of the project's largest intent graph, or null without one. A read
 * failure (the table missing on an old schema, say) is logged and treated as no graph:
 * `fragmented_intents` is then simply not measured.
 */
export async function loadClusterFacts(
  projectId: string,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<ClusterFact[] | null> {
  try {
    const [largest] = await db
      .select({ graphKey: intentGraphClusters.graphKey, n: sql<number>`count(*)::int` })
      .from(intentGraphClusters)
      .where(eq(intentGraphClusters.projectId, projectId))
      .groupBy(intentGraphClusters.graphKey)
      .orderBy(desc(sql`count(*)`), asc(intentGraphClusters.graphKey))
      .limit(1);
    if (!largest) return null;
    return await db
      .select({ memberCount: intentGraphClusters.memberCount })
      .from(intentGraphClusters)
      .where(
        and(
          eq(intentGraphClusters.projectId, projectId),
          eq(intentGraphClusters.graphKey, largest.graphKey),
        ),
      );
  } catch (err) {
    logger.error(
      { err, project_id: projectId },
      "intent graph clusters unreadable for trace signals",
    );
    reportServerException(err, "system:trace-signals", {
      project_id: projectId,
      operation: "trace_signals_load_clusters",
    });
    return null;
  }
}

/** Everything a run reads besides turns. */
export async function loadAnalysisContext(
  projectId: string,
  window: { start: Date; end: Date },
  db: SignalsDb = getDb(),
): Promise<{ context: AnalysisContext; fingerprint: string | null }> {
  const [catalog, usage, clusters, startedAt, otel, previousWorkflows, basisCounts] =
    await Promise.all([
      loadCatalogFacts(projectId, db),
      loadUsageFacts(projectId, db),
      loadClusterFacts(projectId, db),
      ledgerStartedAt(projectId, db),
      loadOtelFacts(projectId, window, db),
      loadPreviousWorkflows(projectId, db),
      loadRunBasisCounts(projectId, window, db),
    ]);
  return {
    context: {
      windowStart: window.start,
      windowEnd: window.end,
      ledgerStartedAt: startedAt,
      catalog: catalog.entries,
      usage,
      clusters,
      otel,
      previousWorkflows,
      runBasis: chooseRunBasis(basisCounts),
    },
    fingerprint: catalog.fingerprint,
  };
}

/**
 * How the window's closed runs were cut (`workflows/run-basis.ts`), counted before the
 * reading so the whole of it, not only the workflows, reads the fixed runs once there are
 * enough of them.
 */
export async function loadRunBasisCounts(
  projectId: string,
  window: { start: Date; end: Date },
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<RunBasisCounts> {
  const inferred = sql`${traceTurns.turnSource} = 'inferred'`;
  const [row] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      withTools: sql<number>`count(*) filter (where ${traceTurns.distinctTools} > 0)::int`,
      inferred: sql<number>`count(*) filter (where ${inferred})::int`,
      capped: sql<number>`count(*) filter (where ${inferred} and ${traceTurns.endedBy} = 'cap')::int`,
      exactMulti: sql<number>`count(*) filter (where not ${inferred} and ${traceTurns.distinctTools} >= 2)::int`,
      exactSince: sql<
        string | null
      >`min(${traceTurns.startedAt}) filter (where not ${inferred} and ${traceTurns.distinctTools} >= 2)::text`,
      inferredMulti: sql<number>`count(*) filter (where ${inferred} and ${traceTurns.distinctTools} >= 2)::int`,
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, window.start),
        lt(traceTurns.endedAt, window.end),
      ),
    );
  return {
    runs: row?.runs ?? 0,
    runsWithTools: row?.withTools ?? 0,
    inferred: row?.inferred ?? 0,
    inferredCapped: row?.capped ?? 0,
    exactMultiTool: row?.exactMulti ?? 0,
    exactSince: row?.exactSince ? new Date(row.exactSince).getTime() : null,
    inferredMultiTool: row?.inferredMulti ?? 0,
  };
}

/** Display names of the project's catalog entries, by entry id. Names only, for claims and chips. */
export async function loadCatalogNames(
  projectId: string,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<Map<string, string>> {
  const rows = await db
    .select({ entryId: runtimeCatalogEntries.entryId, name: runtimeCatalogEntries.name })
    .from(runtimeCatalogEntries)
    .where(eq(runtimeCatalogEntries.projectId, projectId))
    .orderBy(asc(runtimeCatalogEntries.kind), asc(runtimeCatalogEntries.entryId));
  return new Map(rows.map((r) => [r.entryId, r.name]));
}
