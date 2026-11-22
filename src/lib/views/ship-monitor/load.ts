import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { matchQualityProposals } from "@/lib/synthesis/match-quality/schema";
import { toolCraftProposals } from "@/lib/synthesis/tool-crafter/schema";
import { CRAFT_KINDS, type CraftKind } from "@/lib/synthesis/tool-crafter/types";
import { CRAFT_FIX_KIND, type FixKind } from "@/lib/views/fixes/kinds";
import { fixShipments } from "@/lib/views/fixes/schema";
import { lineageLinks } from "@/lib/views/lineage/schema";
import {
  BASELINE_DAYS,
  buildWatch,
  type RunFacts,
  type ShipmentWatch,
  type ToolFacts,
  type TraceFacts,
  type WatchShipment,
} from "./watch";

/**
 * The reads behind a shipment's watch (`watch.ts`): the shipment and its fix's
 * kind and tools, then the fix's tools in the spans of the 7 days before the
 * ship and since it. Only fixes whose tools can be read from their source row
 * are watched: drafted changes (`craft:<id>`) and description rewrites
 * (`rewrite:<id>`); another fix's shipment has no watch.
 */

export type WatchDb = Pick<ReturnType<typeof getDb>, "select" | "execute">;

export interface LoadWatchesOptions {
  now: Date;
  /** Only this shipment; none when it is not one of the project's. */
  shipmentId?: string;
  /** The newest this many shipments with a watch. */
  limit?: number;
}

const DEFAULT_LIMIT = 3;
/** Shipments read to find `limit` with a watch. */
const SHIPMENTS_READ = 20;
const TRACES_SHOWN = 8;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadShipmentWatches(
  projectId: string,
  options: LoadWatchesOptions,
  db: WatchDb = getDb(),
): Promise<ShipmentWatch[]> {
  if (options.shipmentId !== undefined && !UUID.test(options.shipmentId)) return [];
  const shipments = await db
    .select({
      id: fixShipments.id,
      fixId: fixShipments.fixId,
      version: fixShipments.version,
      shippedAt: fixShipments.shippedAt,
    })
    .from(fixShipments)
    .where(
      and(
        eq(fixShipments.projectId, projectId),
        options.shipmentId ? eq(fixShipments.id, options.shipmentId) : undefined,
      ),
    )
    .orderBy(desc(fixShipments.shippedAt), desc(fixShipments.id))
    .limit(SHIPMENTS_READ);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const titles = await fixTitles(
    db,
    projectId,
    shipments.map((row) => row.fixId),
  );
  const watches: ShipmentWatch[] = [];
  // In turn: each watch is a few bounded reads, and most pages need one or two.
  for (const row of shipments) {
    if (watches.length >= limit) break;
    const fix = await fixTools(db, projectId, row.fixId);
    if (!fix || fix.tools.length === 0) continue;
    const shipment: WatchShipment = {
      id: row.id,
      fixId: row.fixId,
      fixKind: fix.kind,
      fixTitle: titles.get(row.fixId) ?? null,
      version: row.version,
      shippedAt: row.shippedAt.toISOString(),
      tools: fix.tools,
    };
    watches.push(
      buildWatch(
        projectId,
        shipment,
        await watchFacts(db, projectId, fix.tools, row.shippedAt, options.now),
        options.now,
      ),
    );
  }
  return watches;
}

/** The fix's kind and tools from its source row, or null for a fix this read does not know. */
async function fixTools(
  db: WatchDb,
  projectId: string,
  fixId: string,
): Promise<{ kind: FixKind; tools: string[] } | null> {
  const [source, id] = splitFixId(fixId);
  if (!id || !UUID.test(id)) return null;
  if (source === "craft") {
    const [row] = await db
      .select({ kind: toolCraftProposals.kind, tools: toolCraftProposals.sourceToolIds })
      .from(toolCraftProposals)
      .where(and(eq(toolCraftProposals.projectId, projectId), eq(toolCraftProposals.id, id)))
      .limit(1);
    return row && isCraftKind(row.kind)
      ? { kind: CRAFT_FIX_KIND[row.kind], tools: row.tools }
      : null;
  }
  if (source === "rewrite") {
    const [row] = await db
      .select({ tool: matchQualityProposals.entryId })
      .from(matchQualityProposals)
      .where(and(eq(matchQualityProposals.projectId, projectId), eq(matchQualityProposals.id, id)))
      .limit(1);
    return row ? { kind: "rewrite", tools: [row.tool] } : null;
  }
  return null;
}

/** Each fix's title as the loop recorded it on its lineage links. */
async function fixTitles(
  db: WatchDb,
  projectId: string,
  fixIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (fixIds.length === 0) return out;
  const rows = await db
    .select({
      sourceId: lineageLinks.sourceId,
      label: lineageLinks.sourceLabel,
      kind: lineageLinks.kind,
    })
    .from(lineageLinks)
    .where(
      and(
        eq(lineageLinks.projectId, projectId),
        eq(lineageLinks.sourceKind, "fix"),
        inArray(lineageLinks.sourceId, [...new Set(fixIds)]),
      ),
    );
  // An eval names the fix by its short form; any other link by its title.
  for (const row of [...rows].sort(
    (a, b) => Number(a.kind === "eval") - Number(b.kind === "eval"),
  )) {
    if (row.label && !out.has(row.sourceId)) out.set(row.sourceId, row.label);
  }
  return out;
}

async function watchFacts(
  db: WatchDb,
  projectId: string,
  tools: readonly string[],
  shippedAt: Date,
  now: Date,
) {
  const baselineFrom = new Date(shippedAt.getTime() - BASELINE_DAYS * DAY_MS);
  const [toolsBefore, toolsAfter, runsBefore, runsAfter, traces] = await Promise.all([
    toolFacts(db, projectId, tools, baselineFrom, shippedAt),
    toolFacts(db, projectId, tools, shippedAt, now),
    runFacts(db, projectId, tools, baselineFrom, shippedAt),
    runFacts(db, projectId, tools, shippedAt, now),
    latestTraces(db, projectId, tools, shippedAt, now),
  ]);
  return {
    before: { tools: toolsBefore, runs: runsBefore },
    after: { tools: toolsAfter, runs: runsAfter },
    traces,
  };
}

const toolName = sql`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;
const toolList = (tools: readonly string[]) =>
  sql`array[${sql.join(
    tools.map((tool) => sql`${tool}`),
    sql`, `,
  )}]::text[]`;

/** Calls, failed calls and median duration of each of the tools in `[from, to)`. */
async function toolFacts(
  db: WatchDb,
  projectId: string,
  tools: readonly string[],
  from: Date,
  to: Date,
): Promise<ToolFacts[]> {
  const result = await db.execute<{
    tool_id: string;
    calls: number;
    errors: number;
    p50_ms: number | null;
  }>(sql`
    select ${toolName} as tool_id,
      count(*)::int as calls,
      count(*) filter (where ${otelSpans.statusCode} = 2)::int as errors,
      percentile_cont(0.5) within group (order by ${otelSpans.durationMs})::float8 as p50_ms
    from ${otelSpans}
    where ${otelSpans.projectId} = ${projectId}
      and ${otelSpans.startedAt} >= ${from.toISOString()} and ${otelSpans.startedAt} < ${to.toISOString()}
      and ${otelSpans.spanClass} = 'tool'
      and ${toolName} = any(${toolList(tools)})
    group by 1`);
  return result.rows.map((row) => ({
    toolId: row.tool_id,
    calls: Number(row.calls),
    errors: Number(row.errors),
    p50Ms: row.p50_ms === null ? null : Number(row.p50_ms),
  }));
}

/** The runs (traces) that call one of the tools in `[from, to)`: how many, their tool calls and model tokens. */
async function runFacts(
  db: WatchDb,
  projectId: string,
  tools: readonly string[],
  from: Date,
  to: Date,
): Promise<RunFacts> {
  const result = await db.execute<{ runs: number; tool_calls: number; tokens: number | null }>(sql`
    with runs as (
      select distinct ${otelSpans.traceId} as trace_id
      from ${otelSpans}
      where ${otelSpans.projectId} = ${projectId}
        and ${otelSpans.startedAt} >= ${from.toISOString()} and ${otelSpans.startedAt} < ${to.toISOString()}
        and ${otelSpans.spanClass} = 'tool'
        and ${toolName} = any(${toolList(tools)})
    )
    select count(distinct runs.trace_id)::int as runs,
      count(*) filter (where s.span_class = 'tool')::int as tool_calls,
      sum(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0)) filter (where s.span_class = 'llm_call' and (s.input_tokens is not null or s.output_tokens is not null))::float8 as tokens
    from runs
    join ${otelSpans} s on s.project_id = ${projectId} and s.trace_id = runs.trace_id`);
  const row = result.rows[0];
  return {
    runs: Number(row?.runs ?? 0),
    toolCalls: Number(row?.tool_calls ?? 0),
    tokens: row?.tokens === null || row?.tokens === undefined ? null : Number(row.tokens),
  };
}

/** The newest traces in `[from, to)` that call one of the tools, with the tools they called. */
async function latestTraces(
  db: WatchDb,
  projectId: string,
  tools: readonly string[],
  from: Date,
  to: Date,
): Promise<TraceFacts[]> {
  const result = await db.execute<{
    trace_id: string;
    started_at: string | Date;
    tools: string[];
    error: boolean;
  }>(sql`
    select ${otelSpans.traceId} as trace_id,
      min(${otelSpans.startedAt}) as started_at,
      array_agg(distinct ${toolName} order by ${toolName}) as tools,
      bool_or(${otelSpans.statusCode} = 2) as error
    from ${otelSpans}
    where ${otelSpans.projectId} = ${projectId}
      and ${otelSpans.startedAt} >= ${from.toISOString()} and ${otelSpans.startedAt} < ${to.toISOString()}
      and ${otelSpans.spanClass} = 'tool'
      and ${toolName} = any(${toolList(tools)})
    group by 1
    order by 2 desc, 1
    limit ${TRACES_SHOWN}`);
  return result.rows.map((row) => ({
    traceId: row.trace_id,
    startedAt: new Date(row.started_at).toISOString(),
    tools: row.tools,
    error: Boolean(row.error),
  }));
}

function isCraftKind(kind: string): kind is CraftKind {
  return (CRAFT_KINDS as readonly string[]).includes(kind);
}

function splitFixId(fixId: string): [string, string | undefined] {
  const at = fixId.indexOf(":");
  return at < 0 ? [fixId, undefined] : [fixId.slice(0, at), fixId.slice(at + 1)];
}
