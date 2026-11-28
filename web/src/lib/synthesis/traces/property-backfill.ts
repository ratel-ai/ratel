import { gunzipSync } from "node:zlib";
import { type SQL, sql } from "drizzle-orm";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { otelSpanRowId } from "@/lib/ingest/otlp/span-rows";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { type OtlpRawExportBody, readOtlpRawExportPage } from "@/lib/ingest/otlp-raw/store";
import { propertyValues, storedPropertyNames } from "@/lib/ingest/properties/keys";
import { loadIndexedProperties } from "@/lib/ingest/properties/store";
import type { getDb } from "@/lib/platform/db/client";
import { TRACE_PROPERTIES } from "@/lib/synthesis/traces/summary-refresh";

/**
 * The fill of trace property values (RTL-395) for traces stored before a property became indexed:
 * it reads the project's raw OTLP exports (`otlp_raw_exports`, so only the window the raw store
 * still holds), computes each span's values as ingest does (`propertyValues`), and fills the
 * spans and the trace summaries that do not have them yet.
 *
 * - It walks the project's exports oldest first, `pageSize` at a time.
 * - Dry run by default: it counts the rows it would fill and writes only with `apply`.
 * - Idempotent, so resumable: it adds only a key a row does not hold, so a re-run writes nothing
 *   and a value ingest or the sweep wrote is never replaced.
 * - `received_at` and `updated_at` are kept, so neither the summary sweep nor the scorers' sweep
 *   runs again for these traces.
 */

export type PropertyBackfillDb = Pick<ReturnType<typeof getDb>, "execute" | "select">;

export interface PropertyBackfillOptions {
  projectId: string;
  /**
   * The properties to fill: only those indexed when the fill runs. Absent, every indexed property
   * whose values `properties` holds.
   */
  names?: string[];
  /** Write the values. Absent or false, a dry run: walk and count, write nothing. */
  apply?: boolean;
  /** Stored exports read per batch. */
  pageSize?: number;
  /** Only exports received from then on. Absent, every stored one. */
  since?: Date;
  onBatch?: (progress: PropertyBackfillResult) => void;
}

export interface PropertyBackfillResult {
  /** Trace exports read. */
  exports: number;
  /** Stored exports that no longer decode: skipped. */
  undecodable: number;
  /** Spans filled (or, in a dry run, that `apply` would fill). */
  spans: number;
  /** Summaries filled (or, in a dry run, that `apply` would fill). */
  summaries: number;
  batches: number;
}

interface SpanFill {
  id: string;
  traceId: string;
  values: Readonly<Record<string, string>>;
}

export const PROPERTY_BACKFILL_PAGE_SIZE = 50;

export async function backfillTraceProperties(
  db: PropertyBackfillDb,
  {
    projectId,
    names,
    apply = false,
    pageSize = PROPERTY_BACKFILL_PAGE_SIZE,
    since = new Date(0),
    onBatch,
  }: PropertyBackfillOptions,
): Promise<PropertyBackfillResult> {
  const progress: PropertyBackfillResult = {
    exports: 0,
    undecodable: 0,
    spans: 0,
    summaries: 0,
    batches: 0,
  };
  // Only names indexed now: a fill queued before a person stopped (and erased) one writes none of it.
  const indexed = await loadIndexedProperties(projectId, db);
  const filled = storedPropertyNames(names ? names.filter((name) => indexed.has(name)) : indexed);
  if (filled.size === 0) return progress;
  let after: OtlpRawExportBody | undefined;
  for (;;) {
    const page = await readOtlpRawExportPage(db, { projectId, since, after, limit: pageSize });
    if (page.length === 0) return progress;
    const fills: SpanFill[] = [];
    for (const row of page) {
      if (row.signal !== "traces") continue;
      progress.exports += 1;
      const spans = decodeStoredExport(row);
      if (!spans) {
        progress.undecodable += 1;
        continue;
      }
      const byTrace = new Map(spans.map((span) => [span.spanId, span.traceId]));
      for (const [spanId, values] of propertyValues(spans, filled))
        fills.push({
          id: otelSpanRowId(projectId, { traceId: byTrace.get(spanId) ?? "", spanId }),
          traceId: byTrace.get(spanId) ?? "",
          values,
        });
    }
    // A span resent in two exports: its first values, as ingest keeps the first row.
    const unique = [...new Map(fills.reverse().map((fill) => [fill.id, fill])).values()];
    if (unique.length > 0) {
      progress.spans += await fillSpans(db, projectId, unique, apply);
      progress.summaries += await fillSummaries(db, projectId, unique, apply);
    }
    progress.batches += 1;
    onBatch?.({ ...progress });
    after = page[page.length - 1];
  }
}

/**
 * The script's arguments as backfill options: `--project <id> [--apply] [--name <name>]...
 * [--since <ISO date>] [--page-size <n>]`. Without `--apply` it is a dry run. `--dry-run` is
 * accepted and changes nothing; with `--apply` it is an error.
 */
export function propertyBackfillOptionsFromArgs(
  argv: readonly string[],
): PropertyBackfillOptions & { apply: boolean; pageSize: number } {
  const values = (flag: string): string[] =>
    argv.flatMap((arg, index) => {
      if (arg !== flag) return [];
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return [next];
    });
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run"))
    throw new Error("--apply and --dry-run cannot go together");
  const [projectId] = values("--project");
  if (!projectId) throw new Error("--project <id> is required");
  const pageSize = Number(values("--page-size")[0] ?? PROPERTY_BACKFILL_PAGE_SIZE);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0)
    throw new Error("--page-size needs a positive integer");
  const names = values("--name");
  const [since] = values("--since");
  if (since && Number.isNaN(Date.parse(since))) throw new Error("--since needs an ISO date");
  return {
    projectId,
    apply,
    pageSize,
    ...(names.length > 0 ? { names } : {}),
    ...(since ? { since: new Date(since) } : {}),
  };
}

function decodeStoredExport(row: OtlpRawExportBody): DecodedSpan[] | null {
  try {
    return decodeOtlp(row.contentType, new Uint8Array(gunzipSync(row.body)));
  } catch {
    return null;
  }
}

/** Add the keys a stored span does not hold yet; the count of spans. */
async function fillSpans(
  db: PropertyBackfillDb,
  projectId: string,
  fills: readonly SpanFill[],
  apply: boolean,
): Promise<number> {
  const values = sql.join(
    fills.map(({ id, values }) => sql`(${id}::uuid, ${JSON.stringify(values)}::jsonb)`),
    sql`, `,
  );
  const match = sql`
    where s.id = v.id and s.project_id = ${projectId}::uuid
      and exists (
        select 1 from jsonb_object_keys(v.properties) k
        where not coalesce(s.properties, '{}'::jsonb) ? k)`;
  const result = await db.execute(
    apply
      ? sql`update otel_spans as s
          set properties = v.properties || coalesce(s.properties, '{}'::jsonb)
          from (values ${values}) as v(id, properties)
          ${match}
          returning 1`
      : sql`select 1 from otel_spans s, (values ${values}) as v(id, properties) ${match}`,
  );
  return rowsOf(result).length;
}

/**
 * Add the keys a summary does not hold yet: the sweep's value over the trace's spans. In a dry
 * run the spans are not filled yet, so each span's new values stand in for theirs.
 */
async function fillSummaries(
  db: PropertyBackfillDb,
  projectId: string,
  fills: readonly SpanFill[],
  apply: boolean,
): Promise<number> {
  const traces = [...new Set(fills.map((fill) => fill.traceId))];
  const changed = sql`changed (project_id, trace_id) as (values ${sql.join(
    traces.map((traceId) => sql`(${projectId}::uuid, ${traceId}::text)`),
    sql`, `,
  )})`;
  const missing = (properties: SQL) => sql`exists (
      select 1 from jsonb_object_keys(${properties}) k where not t.properties ? k)`;
  if (apply) {
    const result = await db.execute(sql`
      with ${changed}, ${TRACE_PROPERTIES}
      update otel_trace_summaries as t
      set properties = tp.properties || t.properties
      from trace_properties tp
      where t.project_id = tp.project_id and t.trace_id = tp.trace_id
        and ${missing(sql`tp.properties`)}
      returning 1`);
    return rowsOf(result).length;
  }
  const keys = sql.join(
    fills.map(({ traceId, values }) => sql`(${traceId}::text, ${JSON.stringify(values)}::jsonb)`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select distinct t.trace_id from otel_trace_summaries t
    join (values ${keys}) as v(trace_id, properties) on v.trace_id = t.trace_id
    where t.project_id = ${projectId}::uuid and ${missing(sql`v.properties`)}`);
  return rowsOf(result).length;
}

function rowsOf<T = unknown>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}
