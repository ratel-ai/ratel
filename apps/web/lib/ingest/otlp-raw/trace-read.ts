import { gunzipSync } from "node:zlib";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { decodeOtlp, decodeOtlpRequest } from "@/lib/ingest/otlp/decode";
import type { DecodedSpan, IExportTraceServiceRequest } from "@/lib/ingest/otlp/types";
import { otlpRawExports } from "@/lib/ingest/otlp-raw/schema";
import type { getDb } from "@/lib/platform/db/client";

export type TraceRawReadDb = Pick<ReturnType<typeof getDb>, "select">;

export interface TraceRawReadQuery {
  projectId: string;
  traceId: string;
  /** Most stored exports to read. */
  maxExports?: number;
  /** Most stored (gzipped) bytes to read; the first export is always read. */
  maxBytes?: number;
}

/** One trace's spans as the customer sent them: every attribute, the resource and the events. */
export interface TraceRawSpans {
  spans: DecodedSpan[];
  /** Stored exports read. */
  exports: number;
  /** Exports read whose body did not decode. */
  undecodable: number;
  /** True when more exports hold this trace than the bounds allowed to read. */
  truncated: boolean;
}

/** The stored export requests that hold one trace, every field kept: what the OTLP download is built from. */
export interface TraceRawRequests {
  requests: IExportTraceServiceRequest[];
  exports: number;
  undecodable: number;
  truncated: boolean;
}

export const DEFAULT_TRACE_RAW_MAX_EXPORTS = 50;
export const DEFAULT_TRACE_RAW_MAX_BYTES = 16 * 1024 ** 2;

/**
 * Read one trace's spans from the raw OTLP exports (RC-411). Rows are found by
 * the GIN-indexed `trace_ids`, oldest first, and bounded by count and stored
 * bytes. Each body is decoded and only this trace's spans are kept, once per
 * span id. A project without raw capture has no rows, so it gets an empty
 * result. Read-only.
 */
export async function readTraceRawSpans(
  db: TraceRawReadDb,
  query: TraceRawReadQuery,
): Promise<TraceRawSpans> {
  const traceId = query.traceId.toLowerCase();
  const read = await readTraceBodies(db, query);
  const result: TraceRawSpans = {
    spans: [],
    exports: read.exports,
    undecodable: 0,
    truncated: read.truncated,
  };
  const bySpanId = new Map<string, DecodedSpan>();
  for (const row of read.bodies) {
    let spans: DecodedSpan[];
    try {
      spans = decodeOtlp(row.contentType, new Uint8Array(gunzipSync(row.body)));
    } catch {
      result.undecodable += 1;
      continue;
    }
    for (const span of spans) {
      if (span.traceId.toLowerCase() !== traceId || bySpanId.has(span.spanId)) continue;
      bySpanId.set(span.spanId, span);
    }
  }
  result.spans = [...bySpanId.values()].sort((a, b) => a.startUnixMs - b.startUnixMs);
  return result;
}

/**
 * The same exports as `readTraceRawSpans`, oldest first, decoded to OTLP/JSON
 * requests with every field kept (RC-454). The caller keeps this trace's spans.
 */
export async function readTraceRawRequests(
  db: TraceRawReadDb,
  query: TraceRawReadQuery,
): Promise<TraceRawRequests> {
  const read = await readTraceBodies(db, query);
  const result: TraceRawRequests = {
    requests: [],
    exports: read.exports,
    undecodable: 0,
    truncated: read.truncated,
  };
  for (const row of read.bodies) {
    try {
      result.requests.push(
        decodeOtlpRequest(row.contentType, new Uint8Array(gunzipSync(row.body))),
      );
    } catch {
      result.undecodable += 1;
    }
  }
  return result;
}

/** The stored bodies of the exports that hold the trace, bounded by count and stored bytes. */
async function readTraceBodies(db: TraceRawReadDb, query: TraceRawReadQuery) {
  const traceId = query.traceId.toLowerCase();
  const maxExports = query.maxExports ?? DEFAULT_TRACE_RAW_MAX_EXPORTS;
  const maxBytes = query.maxBytes ?? DEFAULT_TRACE_RAW_MAX_BYTES;

  const candidates = await db
    .select({ id: otlpRawExports.id, storedBytes: otlpRawExports.storedBytes })
    .from(otlpRawExports)
    .where(
      and(
        eq(otlpRawExports.projectId, query.projectId),
        eq(otlpRawExports.signal, "traces"),
        sql`${otlpRawExports.traceIds} @> array[${traceId}]::text[]`,
      ),
    )
    .orderBy(asc(otlpRawExports.receivedAt), asc(otlpRawExports.id))
    .limit(maxExports + 1);

  const chosen = withinBounds(candidates, maxExports, maxBytes);
  const truncated = chosen.length < candidates.length;
  if (chosen.length === 0) return { bodies: [], exports: 0, truncated };

  const bodies = await db
    .select({
      id: otlpRawExports.id,
      contentType: otlpRawExports.contentType,
      body: otlpRawExports.body,
    })
    .from(otlpRawExports)
    .where(and(eq(otlpRawExports.projectId, query.projectId), inArray(otlpRawExports.id, chosen)))
    .orderBy(asc(otlpRawExports.receivedAt), asc(otlpRawExports.id));
  return { bodies, exports: chosen.length, truncated };
}

function withinBounds(
  candidates: Array<{ id: string; storedBytes: number }>,
  maxExports: number,
  maxBytes: number,
): string[] {
  const chosen: string[] = [];
  let bytes = 0;
  for (const row of candidates) {
    if (chosen.length >= maxExports) break;
    if (chosen.length > 0 && bytes + row.storedBytes > maxBytes) break;
    chosen.push(row.id);
    bytes += row.storedBytes;
  }
  return chosen;
}
