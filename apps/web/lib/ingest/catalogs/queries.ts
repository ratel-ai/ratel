import { createHash } from "node:crypto";
import { and, asc, eq, gte, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { skills, toolDefinitions } from "@/lib/catalog/schema";
import { catalogSnapshots, catalogToolDefinitions } from "@/lib/ingest/catalogs/schema";
import { GATEWAY_TOOL_IDS, isGatewayTool } from "@/lib/ingest/gateway-tools";
import { eventMetrics } from "@/lib/ingest/otlp/schema";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { runtimeEventSources } from "@/lib/ingest/runtime-events/schema";
import { toolUsageCounters, traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import type { CatalogSnapshot } from "./snapshot";
import { CATALOG_INACTIVE_DAYS, CATALOG_STALE_DAYS } from "./vocabulary";

/** A synced tool's name, description and optional parameters (no UI provenance). */
export type SyncedToolDefinition = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The instant before which a source counts as stale, or as gone entirely. */
function silenceCutoffs(now: Date): { staleBefore: Date; inactiveBefore: Date } {
  return {
    staleBefore: new Date(now.getTime() - CATALOG_STALE_DAYS * DAY_MS),
    inactiveBefore: new Date(now.getTime() - CATALOG_INACTIVE_DAYS * DAY_MS),
  };
}

export type ObservedTool = {
  name: string;
  calls: number;
  tokens: number;
  costUsd: number;
  lastSeenAt: Date;
};

export type CatalogCounts = {
  publishedSkills: number;
  observedTools: number;
};

export type CatalogCountsOptions = {
  includeSyncedTools?: boolean;
  now?: Date;
};

export type SyncedTool = {
  sourceId: string;
  sourceStatus: "fresh" | "stale" | "inactive";
  sourceLastSeenAt: Date;
  /** Set once the source's first runtime fact arrives; null for catalog-only sources. */
  factsStartedAt: Date | null;
  toolId: string;
  name: string;
  description: string;
  /** What the publisher asked us to match on, when it sent something different. */
  searchableDescription: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  calls: number;
  errors: number;
  lastUsedAt: Date | null;
};

export type SyncedToolsOptions = {
  now?: Date;
  includeInactive?: boolean;
};

export type CatalogQueriesDb = Pick<ReturnType<typeof getDb>, "execute" | "select" | "transaction">;

/** Atomically replace one source's current catalog, or heartbeat an exact replay. */
export async function replaceCatalogSnapshot(
  projectId: string,
  snapshot: CatalogSnapshot,
  db: CatalogQueriesDb = getDb(),
  receivedAt: Date = new Date(),
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(runtimeEventSources)
      .values({
        projectId,
        sourceId: snapshot.sourceId,
        factsStartedAt: null,
        firstSeenAt: receivedAt,
        lastSeenAt: receivedAt,
      })
      .onConflictDoUpdate({
        target: [runtimeEventSources.projectId, runtimeEventSources.sourceId],
        set: { lastSeenAt: receivedAt },
      });

    if (snapshot.tools.length > 0) {
      await upsertRuntimeCatalogEntries(
        snapshot.tools.map((tool) => ({
          projectId,
          kind: "tool",
          entryId: tool.toolId,
          name: tool.name,
          description: tool.description,
          tags: [],
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          searchableDescription: tool.searchableDescription ?? tool.description,
          // The flag the Catalogs UI reads as "the runtime customised this".
          // A publisher echoing `description` back has customised nothing.
          searchableDescriptionOverridden:
            tool.searchableDescription !== undefined &&
            tool.searchableDescription !== tool.description,
          useCloudDefinitions: false,
          contentHash: snapshotEntryHash(snapshot.hash, tool.toolId),
          firstSeenAt: receivedAt,
          lastSeenAt: receivedAt,
        })),
        "snapshot",
        tx,
      );
    }

    const inserted = await tx
      .insert(catalogSnapshots)
      .values({
        projectId,
        sourceId: snapshot.sourceId,
        contentHash: snapshot.hash,
        toolCount: snapshot.tools.length,
        receivedAt,
      })
      .onConflictDoNothing()
      .returning({ sourceId: catalogSnapshots.sourceId });

    if (inserted.length === 0) {
      const [current] = await tx
        .select({ contentHash: catalogSnapshots.contentHash })
        .from(catalogSnapshots)
        .where(
          and(
            eq(catalogSnapshots.projectId, projectId),
            eq(catalogSnapshots.sourceId, snapshot.sourceId),
          ),
        )
        .for("update");
      if (current?.contentHash === snapshot.hash) {
        await tx
          .update(catalogSnapshots)
          .set({ receivedAt })
          .where(
            and(
              eq(catalogSnapshots.projectId, projectId),
              eq(catalogSnapshots.sourceId, snapshot.sourceId),
            ),
          );
        return { changed: false };
      }
    }

    await tx
      .delete(catalogToolDefinitions)
      .where(
        and(
          eq(catalogToolDefinitions.projectId, projectId),
          eq(catalogToolDefinitions.sourceId, snapshot.sourceId),
        ),
      );
    if (snapshot.tools.length > 0) {
      await tx.insert(catalogToolDefinitions).values(
        snapshot.tools.map((tool) => ({
          projectId,
          sourceId: snapshot.sourceId,
          toolId: tool.toolId,
          name: tool.name,
          description: tool.description,
          searchableDescription: tool.searchableDescription ?? null,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          metadata: tool.metadata,
        })),
      );
    }
    if (inserted.length === 0) {
      await tx
        .update(catalogSnapshots)
        .set({
          contentHash: snapshot.hash,
          toolCount: snapshot.tools.length,
          receivedAt,
        })
        .where(
          and(
            eq(catalogSnapshots.projectId, projectId),
            eq(catalogSnapshots.sourceId, snapshot.sourceId),
          ),
        );
    }
    // `runtime_catalog_entries` has no source column, so an entry survives
    // while ANY source still defines it. That has to exclude sources which
    // have themselves gone quiet past the inactive cutoff: a project that
    // re-onboards under a new source id leaves the old source's definitions
    // behind forever, and those rows would otherwise pin dropped tools alive
    // for the life of the project, invisibly, since `listSyncedTools` has
    // already stopped showing the source that is doing the pinning.
    const { inactiveBefore } = silenceCutoffs(receivedAt);
    const snapshotDefinitionExists = tx
      .select({ toolId: catalogToolDefinitions.toolId })
      .from(catalogToolDefinitions)
      .innerJoin(
        runtimeEventSources,
        and(
          eq(runtimeEventSources.projectId, catalogToolDefinitions.projectId),
          eq(runtimeEventSources.sourceId, catalogToolDefinitions.sourceId),
        ),
      )
      .where(
        and(
          eq(catalogToolDefinitions.projectId, projectId),
          eq(catalogToolDefinitions.toolId, runtimeCatalogEntries.entryId),
          gte(runtimeEventSources.lastSeenAt, inactiveBefore),
        ),
      );
    // Snapshots drop tools for transient reasons: an unreachable upstream
    // server, a flagged-off group, a canary registering a subset. The
    // override column is the only copy of the operator's edit there is. Rows
    // carrying one therefore outlive the snapshot that introduced them; only
    // untouched ones are pruned.
    await tx
      .delete(runtimeCatalogEntries)
      .where(
        and(
          eq(runtimeCatalogEntries.projectId, projectId),
          eq(runtimeCatalogEntries.kind, "tool"),
          eq(runtimeCatalogEntries.provenance, "snapshot"),
          isNull(runtimeCatalogEntries.searchableDescriptionOverride),
          notExists(snapshotDefinitionExists),
        ),
      );
    await tx
      .update(runtimeCatalogEntries)
      .set({ provenance: "events" })
      .where(
        and(
          eq(runtimeCatalogEntries.projectId, projectId),
          eq(runtimeCatalogEntries.kind, "tool"),
          eq(runtimeCatalogEntries.provenance, "both"),
          notExists(snapshotDefinitionExists),
        ),
      );
    return { changed: true };
  });
}

function snapshotEntryHash(snapshotHash: string, entryId: string): string {
  return createHash("sha256").update(`${snapshotHash}\0${entryId}`, "utf8").digest("hex");
}

/** Current per-source definitions joined to exact direct-facts usage counters. */
export async function listSyncedTools(
  projectId: string,
  options: SyncedToolsOptions = {},
  db: CatalogQueriesDb = getDb(),
): Promise<SyncedTool[]> {
  const now = options.now ?? new Date();
  const { staleBefore, inactiveBefore } = silenceCutoffs(now);
  const freshness = options.includeInactive
    ? undefined
    : gte(runtimeEventSources.lastSeenAt, inactiveBefore);
  const rows = await db
    .select({
      sourceId: catalogToolDefinitions.sourceId,
      sourceLastSeenAt: runtimeEventSources.lastSeenAt,
      factsStartedAt: runtimeEventSources.factsStartedAt,
      toolId: catalogToolDefinitions.toolId,
      name: catalogToolDefinitions.name,
      description: catalogToolDefinitions.description,
      searchableDescription: catalogToolDefinitions.searchableDescription,
      inputSchema: catalogToolDefinitions.inputSchema,
      outputSchema: catalogToolDefinitions.outputSchema,
      metadata: catalogToolDefinitions.metadata,
      calls: toolUsageCounters.calls,
      errors: toolUsageCounters.errors,
      lastUsedAt: toolUsageCounters.lastUsedAt,
    })
    .from(catalogToolDefinitions)
    .innerJoin(
      runtimeEventSources,
      and(
        eq(runtimeEventSources.projectId, catalogToolDefinitions.projectId),
        eq(runtimeEventSources.sourceId, catalogToolDefinitions.sourceId),
      ),
    )
    .leftJoin(
      toolUsageCounters,
      and(
        eq(toolUsageCounters.projectId, catalogToolDefinitions.projectId),
        eq(toolUsageCounters.sourceId, catalogToolDefinitions.sourceId),
        eq(toolUsageCounters.toolId, catalogToolDefinitions.toolId),
      ),
    )
    .where(and(eq(catalogToolDefinitions.projectId, projectId), freshness))
    .orderBy(asc(catalogToolDefinitions.name), asc(catalogToolDefinitions.sourceId));

  return rows.map((row) => ({
    ...row,
    sourceStatus:
      row.sourceLastSeenAt < inactiveBefore
        ? "inactive"
        : row.sourceLastSeenAt < staleBefore
          ? "stale"
          : "fresh",
    calls: row.calls ?? 0,
    errors: row.errors ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
  }));
}

/**
 * One row per tool observed in a project's retained agent-event metrics. Cost is
 * attributed with the same input-token weighting as the dashboard: first to the
 * tools source, then to each definition by its share of the event's input tokens.
 */
export async function listObservedTools(
  projectId: string,
  db: CatalogQueriesDb = getDb(),
): Promise<ObservedTool[]> {
  const result = await db.execute(sql`
    with expanded as (
      select
        metric.event_time,
        coalesce(metric.cost_usd, 0)::numeric as event_cost_usd,
        coalesce(
          nullif(metric.input_tokens, 0),
          nullif((
            select sum(category.value::numeric)
            from jsonb_each_text(metric.tokens_by_category) as category
          ), 0)
        )::numeric as event_input_tokens,
        tool.name,
        coalesce((tool.stat ->> 'calls')::int, 0) as calls,
        coalesce((tool.stat ->> 'tokens')::int, 0) as tokens
      from ${eventMetrics} as metric
      cross join lateral jsonb_each(metric.tools_by_name) as tool(name, stat)
      where metric.project_id = ${projectId}
    )
    select
      name,
      sum(calls)::int as calls,
      sum(tokens)::int as tokens,
      coalesce(sum(
        case
          when event_input_tokens > 0
            then event_cost_usd * tokens / event_input_tokens
          else 0
        end
      ), 0)::float8 as cost_usd,
      max(event_time) as last_seen_at
    from expanded
    group by name
    order by sum(calls) desc, sum(tokens) desc, name asc
  `);

  return result.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        name: String(row.name),
        calls: Number(row.calls),
        tokens: Number(row.tokens),
        costUsd: Number(row.cost_usd),
        lastSeenAt: new Date(row.last_seen_at as string | Date),
      };
    })
    .filter((tool) => !isGatewayTool(tool.name));
}

/**
 * The synced definitions for a project's tools, in the shape the catalog
 * builder joins onto observed usage. Gateway tools are filtered on the same
 * rule as `listObservedTools`, so a definition cannot reintroduce a tool the
 * usage read deliberately hides.
 */
export async function listToolDefinitions(
  projectId: string,
  db: CatalogQueriesDb = getDb(),
): Promise<SyncedToolDefinition[]> {
  const result = await db.execute(sql`
    select name, description, parameters
    from ${toolDefinitions}
    where ${toolDefinitions.projectId} = ${projectId}
    order by name asc
  `);

  return result.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      const parameters = row.parameters;
      return {
        name: String(row.name),
        description: String(row.description ?? ""),
        ...(parameters && typeof parameters === "object"
          ? { parameters: parameters as Record<string, unknown> }
          : {}),
      };
    })
    .filter((definition) => !isGatewayTool(definition.name));
}

/** Lightweight totals for the three-card catalogs index. */
export async function getCatalogCounts(
  projectId: string,
  optionsOrDb: CatalogCountsOptions | CatalogQueriesDb = {},
  suppliedDb?: CatalogQueriesDb,
): Promise<CatalogCounts> {
  const options = "execute" in optionsOrDb ? {} : optionsOrDb;
  const db = "execute" in optionsOrDb ? optionsOrDb : (suppliedDb ?? getDb());
  const gatewayToolNames = sql.join(
    [...GATEWAY_TOOL_IDS].map((name) => sql`${name}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select
      (
        select count(*)
        from ${skills}
        where ${skills.projectId} = ${projectId}
          and ${skills.status} = 'published'
      )::int as published_skills,
      (
        select count(distinct tool.name)
        from ${eventMetrics} as metric
        cross join lateral jsonb_object_keys(metric.tools_by_name) as tool(name)
        where metric.project_id = ${projectId}
          and tool.name not in (${gatewayToolNames})
      )::int as observed_tools
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  if (!options.includeSyncedTools) {
    return {
      publishedSkills: Number(row.published_skills ?? 0),
      observedTools: Number(row.observed_tools ?? 0),
    };
  }
  const [syncedTools, observedToolNames] = await Promise.all([
    listSyncedTools(projectId, { now: options.now }, db),
    listObservedToolNames(projectId, db),
  ]);
  return {
    publishedSkills: Number(row.published_skills ?? 0),
    observedTools: new Set([...syncedTools.map((tool) => tool.name), ...observedToolNames]).size,
  };
}

async function listObservedToolNames(projectId: string, db: CatalogQueriesDb): Promise<string[]> {
  const gatewayToolNames = sql.join(
    [...GATEWAY_TOOL_IDS].map((name) => sql`${name}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select distinct tool.name
    from ${eventMetrics} as metric
    cross join lateral jsonb_object_keys(metric.tools_by_name) as tool(name)
    where metric.project_id = ${projectId}
      and tool.name not in (${gatewayToolNames})
  `);
  return result.rows.map((raw) => String((raw as Record<string, unknown>).name));
}

export type SkillRunCount = {
  /** The skill id the runtime reports: a Cloud skill's name, or a runtime skill's own id. */
  skillId: string;
  runs: number;
  lastRunAt: Date;
};

/**
 * How often each skill ran: its `skill_invoke` events among the retained trace
 * events, with the latest one. Grouped on the `(project_id, type, skill_id)`
 * index the "searched but never invoked" probe already uses.
 */
export async function listSkillRunCounts(
  projectId: string,
  db: CatalogQueriesDb = getDb(),
): Promise<SkillRunCount[]> {
  const eventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const rows = await db
    .select({
      skillId: traceEvents.skillId,
      runs: sql<number>`count(*)::int`,
      lastRunAt: sql<Date | string>`max(${eventTime})`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, "skill_invoke"),
        isNotNull(traceEvents.skillId),
      ),
    )
    .groupBy(traceEvents.skillId)
    .orderBy(asc(traceEvents.skillId));
  return rows.map((row) => ({
    skillId: String(row.skillId),
    runs: Number(row.runs),
    lastRunAt: new Date(row.lastRunAt),
  }));
}
