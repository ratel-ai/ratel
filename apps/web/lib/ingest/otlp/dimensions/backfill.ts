import { sql } from "drizzle-orm";
import { deriveSpanDimensions, type SpanDimensions } from "@/lib/ingest/otlp/dimensions";
import type { getDb } from "@/lib/platform/db/client";
import { indexSpans } from "../attr-resolve";
import type { AttrMap, DecodedSpan } from "../types";

/**
 * One-off backfill of the entity dimension columns of `otel_spans` (RC-772,
 * migration 0106) for spans stored before ingest wrote them.
 *
 * It walks the traces that hold a span with no dimension, in `(project_id,
 * trace_id)` keyset batches, rebuilds each trace's spans from their stored
 * rows and gives them to the same `deriveSpanDimensions` ingest uses.
 *
 * - Dry run by default: it walks and counts, and writes only with `apply`.
 * - Idempotent: only a span with no dimension is written, so a re-run writes
 *   nothing, and a value ingest wrote is never replaced.
 * - `received_at` is kept, so the trace summary sweep cursor does not move.
 * - A stored row keeps `gen_ai.*` and `ratel.*` attributes only
 *   (`span-rows.ts`). So the backfill reads `gen_ai.agent.name` and
 *   `gen_ai.agent.id`, the `invoke_agent` spans, `service.name`,
 *   `ratel.upstream.server`, the tool-name prefix and an MCP server span by
 *   its name and kind. It cannot read `agent.name`, a framework's agent
 *   attribute or `mcp.method.name`: those were not stored. It does not fill
 *   `mcp_session_id` either.
 * - An Agent health import is refilled by its own reprocess instead (PR #465:
 *   it stores its spans again with every column).
 *
 * A span with no agent, no service name and no MCP call stays empty; a re-run
 * reads its trace again and writes nothing.
 */

export type EntityDimensionsBackfillDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface EntityDimensionsBackfillOptions {
  /** One project only. Absent, every project. */
  projectId?: string;
  /** Only spans received before this. Absent, every span. */
  before?: Date;
  /** Traces per batch. */
  batchSize?: number;
  /** Write the dimensions. Absent or false, a dry run: walk and count, write nothing. */
  apply?: boolean;
  onBatch?: (progress: EntityDimensionsBackfillResult) => void;
}

export interface EntityDimensionsBackfillResult {
  /** Traces that held a span to fill. */
  traces: number;
  /** Spans filled (or, in a dry run, that `apply` would fill). */
  spans: number;
  batches: number;
}

interface TraceKey {
  projectId: string;
  traceId: string;
}

interface StoredSpanRow {
  id: string;
  project_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  service_name: string | null;
  attributes: AttrMap | null;
  empty: boolean;
}

interface SpanUpdate {
  id: string;
  dimensions: SpanDimensions;
}

export const ENTITY_DIMENSIONS_BACKFILL_BATCH_SIZE = 200;
const UPDATE_CHUNK_SIZE = 500;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** A span ingest has not given a dimension: none of them is set. */
const EMPTY = sql`agent_key is null and mcp_server is null and mcp_role is null`;

export async function backfillEntityDimensions(
  db: EntityDimensionsBackfillDb,
  {
    projectId,
    before,
    batchSize = ENTITY_DIMENSIONS_BACKFILL_BATCH_SIZE,
    apply = false,
    onBatch,
  }: EntityDimensionsBackfillOptions,
): Promise<EntityDimensionsBackfillResult> {
  const progress: EntityDimensionsBackfillResult = { traces: 0, spans: 0, batches: 0 };
  let after: TraceKey = { projectId: NIL_UUID, traceId: "" };
  for (;;) {
    const batch = await nextBatch(db, { projectId, before }, after, batchSize);
    if (batch.length === 0) return progress;
    const updates = dimensionUpdates(await storedSpans(db, batch));
    if (apply) await writeUpdates(db, updates);
    progress.traces += batch.length;
    progress.spans += updates.length;
    progress.batches += 1;
    onBatch?.({ ...progress });
    after = batch[batch.length - 1]!;
  }
}

/**
 * The script's arguments as backfill options: `[--apply] [--project <id>]
 * [--before <ISO time>] [--batch-size <n>]`. Without `--apply` it is a dry run.
 * `--dry-run` is accepted and changes nothing; with `--apply` it is an error.
 */
export function backfillOptionsFromArgs(
  argv: readonly string[],
): EntityDimensionsBackfillOptions & { apply: boolean; batchSize: number } {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${name} needs a value`);
    return next;
  };
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run"))
    throw new Error("--apply and --dry-run cannot go together");
  const beforeArg = value("--before");
  const before = beforeArg === undefined ? undefined : new Date(beforeArg);
  if (before && Number.isNaN(before.getTime())) throw new Error("--before needs an ISO time");
  const batchSize = Number(value("--batch-size") ?? ENTITY_DIMENSIONS_BACKFILL_BATCH_SIZE);
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error("--batch-size needs a positive integer");
  const projectId = value("--project");
  return { apply, batchSize, ...(projectId ? { projectId } : {}), ...(before ? { before } : {}) };
}

/** The next traces, in key order, that hold a span with no dimension. */
async function nextBatch(
  db: EntityDimensionsBackfillDb,
  scope: { projectId?: string; before?: Date },
  after: TraceKey,
  limit: number,
): Promise<TraceKey[]> {
  const result = await db.execute(sql`
    select distinct project_id, trace_id from otel_spans
    where (project_id, trace_id) > (${after.projectId}::uuid, ${after.traceId}::text)
      and ${EMPTY}
      ${scope.projectId ? sql`and project_id = ${scope.projectId}::uuid` : sql``}
      ${scope.before ? sql`and received_at < ${scope.before.toISOString()}::timestamptz` : sql``}
    order by project_id, trace_id
    limit ${limit}`);
  return rowsOf<{ project_id: string; trace_id: string }>(result).map((row) => ({
    projectId: row.project_id,
    traceId: row.trace_id,
  }));
}

/** Every stored span of the traces: the whole trace is the context of each span. */
async function storedSpans(
  db: EntityDimensionsBackfillDb,
  traces: readonly TraceKey[],
): Promise<StoredSpanRow[]> {
  const keys = sql.join(
    traces.map((trace) => sql`(${trace.projectId}::uuid, ${trace.traceId}::text)`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select id, project_id, trace_id, span_id, parent_span_id, name, kind, service_name, attributes,
      (${EMPTY}) as empty
    from otel_spans
    where (project_id, trace_id) in (${keys})`);
  return rowsOf<StoredSpanRow>(result);
}

/** The dimensions of each empty span, derived within its own trace. Spans that get none are left out. */
function dimensionUpdates(rows: readonly StoredSpanRow[]): SpanUpdate[] {
  const byTrace = new Map<string, StoredSpanRow[]>();
  for (const row of rows) {
    const key = `${row.project_id}:${row.trace_id}`;
    byTrace.set(key, [...(byTrace.get(key) ?? []), row]);
  }
  const out: SpanUpdate[] = [];
  for (const trace of byTrace.values()) {
    const spans = trace.map(toDecodedSpan);
    const dimensions = deriveSpanDimensions(spans, indexSpans(spans));
    for (const row of trace) {
      const own = dimensions.get(row.span_id);
      if (row.empty && own && (own.agentKey || own.mcpServer || own.mcpRole))
        out.push({ id: row.id, dimensions: own });
    }
  }
  return out;
}

/** A stored row as the span ingest saw, as far as the row keeps it. */
function toDecodedSpan(row: StoredSpanRow): DecodedSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    startUnixMs: 0,
    endUnixMs: 0,
    attributes: row.attributes ?? {},
    events: [],
    statusCode: 0,
    resourceAttributes: row.service_name ? { "service.name": row.service_name } : {},
    scopeName: null,
  };
}

async function writeUpdates(
  db: EntityDimensionsBackfillDb,
  updates: readonly SpanUpdate[],
): Promise<void> {
  for (let offset = 0; offset < updates.length; offset += UPDATE_CHUNK_SIZE) {
    const values = sql.join(
      updates
        .slice(offset, offset + UPDATE_CHUNK_SIZE)
        .map(
          ({ id, dimensions: d }) =>
            sql`(${id}::uuid, ${d.agentKey}::text, ${d.agentSource}::text, ${d.callerAgentKey}::text, ${d.mcpServer}::text, ${d.mcpServerSource}::text, ${d.mcpRole}::text)`,
        ),
      sql`, `,
    );
    // Still empty: a span ingest filled since the read keeps its value.
    await db.execute(sql`
      update otel_spans as s set
        agent_key = v.agent_key,
        agent_source = v.agent_source,
        caller_agent_key = v.caller_agent_key,
        mcp_server = v.mcp_server,
        mcp_server_source = v.mcp_server_source,
        mcp_role = v.mcp_role
      from (values ${values}) as v(id, agent_key, agent_source, caller_agent_key, mcp_server, mcp_server_source, mcp_role)
      where s.id = v.id and s.agent_key is null and s.mcp_server is null and s.mcp_role is null`);
  }
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}
