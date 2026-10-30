import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { promptOf } from "@/lib/ingest/otlp/prompt-text";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import type { AttrMap } from "@/lib/ingest/otlp/types";
import { getDb } from "@/lib/platform/db/client";
import type { TraceQueriesDb } from "./queries";
import { toolNameFromSpanName } from "./v2/span-kind";

/**
 * What the v2 Runs list shows for one page of runs beyond their summary rows,
 * in reads bounded by the `(project_id, trace_id)` index. The page runs each
 * read under its own timeout, so a slow one costs the page only its own
 * column.
 */

/** The ask, when the customer captures message content, and whether the run has ended. */
export interface RunAsk {
  prompt: string | null;
  /**
   * The run's top-level span has arrived. Spans are sent as they end and the
   * top-level one ends last, so a run without it is still going, or its end
   * was never sent.
   */
  hasRoot: boolean;
}

/**
 * Tools each run called, in the order it first called each.
 *
 * OpenTelemetry names a tool span `execute_tool <tool>`, so the name is read
 * from the span name; only spans named otherwise open their attributes for
 * `gen_ai.tool.name`. A run with thousands of tool calls never decodes
 * thousands of argument payloads.
 */
export async function listRunTools(
  projectId: string,
  traceIds: readonly string[],
  db: TraceQueriesDb = getDb(),
): Promise<Map<string, string[]>> {
  const ids = [...new Set(traceIds)];
  if (ids.length === 0) return new Map();

  const toolName = sql<string>`case when left(${otelSpans.name}, 13) = 'execute_tool ' then ${otelSpans.name} else coalesce(nullif(btrim(${otelSpans.attributes} ->> 'gen_ai.tool.name'), ''), ${otelSpans.name}) end`;
  const rows = await db
    .select({ traceId: otelSpans.traceId, tool: toolName })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        inArray(otelSpans.traceId, ids),
        eq(otelSpans.spanClass, "tool"),
      ),
    )
    .groupBy(otelSpans.traceId, toolName)
    .orderBy(otelSpans.traceId, sql`min(${otelSpans.startedAt})`, toolName);

  // Rows arrive per run in first-call order; the span-name cleanup can merge
  // two raw names into one tool, which keeps its first place.
  return new Map(
    ids.map((id) => [
      id,
      unique(
        rows
          .filter((row) => row.traceId === id)
          .map((row) => toolNameFromSpanName(row.tool))
          .filter(Boolean),
      ),
    ]),
  );
}

/**
 * Each run's ask and whether its top-level span has arrived.
 *
 * The ask comes from the run's first model call (the last user message going
 * into it) or, failing that, its top-level span. Both are picked by id alone,
 * then only the picked rows' attributes are read: the cost stays a few rows
 * per run however many model calls it made. Content-capture-off projects have
 * no message attributes and get `null`.
 */
export async function listRunAsks(
  projectId: string,
  traceIds: readonly string[],
  db: TraceQueriesDb = getDb(),
): Promise<Map<string, RunAsk>> {
  const ids = [...new Set(traceIds)];
  if (ids.length === 0) return new Map();

  const inRuns = and(eq(otelSpans.projectId, projectId), inArray(otelSpans.traceId, ids));
  const firstPerRun = (where: ReturnType<typeof and>) =>
    db
      .selectDistinctOn([otelSpans.traceId], { traceId: otelSpans.traceId, id: otelSpans.id })
      .from(otelSpans)
      .where(where)
      .orderBy(otelSpans.traceId, otelSpans.startedAt, otelSpans.spanId);
  const [modelCalls, roots] = await Promise.all([
    firstPerRun(and(inRuns, eq(otelSpans.spanClass, "llm_call"))),
    firstPerRun(and(inRuns, isNull(otelSpans.parentSpanId))),
  ]);

  const picked = [...modelCalls, ...roots];
  const attributeRows =
    picked.length > 0
      ? await db
          .select({ id: otelSpans.id, attributes: otelSpans.attributes })
          .from(otelSpans)
          .where(
            and(
              eq(otelSpans.projectId, projectId),
              inArray(
                otelSpans.id,
                picked.map((row) => row.id),
              ),
            ),
          )
      : [];
  const attributesById = new Map(attributeRows.map((row) => [row.id, row.attributes]));
  const askOf = (row: { id: string } | undefined): string | null => {
    const attributes = row ? attributesById.get(row.id) : undefined;
    return attributes ? promptOf(attributes as AttrMap)?.trim() || null : null;
  };

  const modelCallByRun = new Map(modelCalls.map((row) => [row.traceId, row]));
  const rootByRun = new Map(roots.map((row) => [row.traceId, row]));
  // The first model call wins; the top-level span is the fallback.
  return new Map(
    ids.map((id) => [
      id,
      {
        prompt: askOf(modelCallByRun.get(id)) ?? askOf(rootByRun.get(id)),
        hasRoot: rootByRun.has(id),
      },
    ]),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
