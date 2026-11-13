import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { deriveModelCalls, OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveToolInvocations } from "@/lib/ingest/otlp/derive-tools";
import { groupSpans } from "@/lib/ingest/otlp/group";
import { normalizeAiSdkSpans } from "@/lib/ingest/otlp/normalize-ai-sdk";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { DEV_TRACE_SIGNALS_HASH_SALT } from "@/lib/ledger/hash";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import type { TurnDraft, TurnEventRow } from "@/lib/ledger/types";
import {
  buildOtelFacts,
  type OtelFactRow,
  type OtelFacts,
} from "@/lib/readings/trace-signals/signals/otel-facts";

/**
 * Test support for the real-library fixtures in `__fixtures__/real/`: the raw
 * OTLP/HTTP bodies an agent library exported (see the README there), pushed
 * through the same pure steps the traces route runs for Agent health:
 * decode, AI SDK normalization, tool and model-call derivation, then the turn
 * builder over the derived rows as the ledger would read them back.
 */

// Owned (ADR-0030): the fixtures sit with the ingest module; this helper sits with the ledger it replays through.
export const REAL_FIXTURES_DIR = join(process.cwd(), "lib/ingest/otlp/__fixtures__/real");

export interface FixtureBody {
  file: string;
  contentType: string;
  bytes: Uint8Array;
}

const BODY_FILE = /-traces\.(json|pb)(\.gz)?$/;

/**
 * A fixture's request bodies, in the order they were exported, as sent (the
 * files are the raw bodies gzipped for the repo; a body without `.gz` is read
 * as is). Trace bodies only.
 */
export function loadFixture(name: string, dir: string = REAL_FIXTURES_DIR): FixtureBody[] {
  const folder = join(dir, name);
  return readdirSync(folder)
    .filter((file) => BODY_FILE.test(file))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(folder, file));
      return {
        file,
        contentType:
          BODY_FILE.exec(file)?.[1] === "json" ? "application/json" : "application/x-protobuf",
        bytes: new Uint8Array(file.endsWith(".gz") ? gunzipSync(raw) : raw),
      };
    });
}

export interface PipelineResult {
  spans: DecodedSpan[];
  /** LLM calls the events table gets (`groupSpans`). */
  llmCalls: number;
  toolRows: ParsedTraceEvent[];
  modelRows: ParsedTraceEvent[];
  turns: TurnDraft[];
  facts: OtelFacts;
}

const RECEIPT_LAG_MS = 500;

function uuidOf(text: string): string {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A derived row as the turn pager reads it back from `trace_events`. */
export function asTurnEventRow(row: ParsedTraceEvent, receivedAt: Date): TurnEventRow {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: uuidOf(row.clientEventId),
    type: row.type,
    sessionId: row.sessionId,
    sourceId: row.sourceId,
    ingestSource: row.ingestSource ?? null,
    occurredAt: row.occurredAt,
    receivedAt,
    turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
    invocationId: row.invocationId,
    traceId: row.traceId,
    toolId: row.toolId,
    skillId: row.skillId,
    query: row.query,
    topK: row.topK,
    hitCount: row.hitCount,
    tookMs: row.tookMs,
    endUserId: row.endUserId,
    ...(payload.root_tool === true ? { rootTool: true } : {}),
  };
}

function factRowOf(row: ParsedTraceEvent): OtelFactRow {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: uuidOf(row.clientEventId),
    type: row.type,
    traceId: row.traceId,
    errorType: row.errorMessage,
    resultEmpty: typeof payload.result_empty === "boolean" ? payload.result_empty : null,
    argHash: typeof payload.arg_hash === "string" ? payload.arg_hash : null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    menu: Array.isArray(payload.menu) ? (payload.menu as string[]) : null,
  };
}

/** Every body through decode and derivation, then the derived rows through the turn builder. */
export function runPipeline(bodies: readonly FixtureBody[]): PipelineResult {
  const spans: DecodedSpan[] = [];
  const toolRows: ParsedTraceEvent[] = [];
  const modelRows: ParsedTraceEvent[] = [];
  const eventRows: TurnEventRow[] = [];
  let llmCalls = 0;
  // The store keeps one row per client event id, the first to arrive.
  const seen = new Set<string>();
  const fresh = (row: ParsedTraceEvent): boolean =>
    !seen.has(row.clientEventId) && Boolean(seen.add(row.clientEventId));
  for (const body of bodies) {
    const decoded = decodeOtlp(body.contentType, body.bytes);
    normalizeAiSdkSpans(decoded);
    llmCalls += groupSpans(decoded).length;
    const tools = deriveToolInvocations(decoded).filter(fresh);
    const models = deriveModelCalls(decoded).filter(fresh);
    const latest = Math.max(0, ...decoded.map((s) => s.endUnixMs));
    const receivedAt = new Date(latest + RECEIPT_LAG_MS);
    spans.push(...decoded);
    toolRows.push(...tools);
    modelRows.push(...models);
    eventRows.push(...tools.map((row) => asTurnEventRow(row, receivedAt)));
  }
  const normalized = normalizeEvents(eventRows, new Map(), { salt: DEV_TRACE_SIGNALS_HASH_SALT });
  const now = new Date(
    Math.max(0, ...eventRows.map((r) => r.receivedAt.getTime())) + 24 * 3_600_000,
  );
  const { turns } = buildTurns({ stored: [], events: normalized, now });
  const facts = buildOtelFacts([...toolRows, ...modelRows].map(factRowOf));
  return { spans, llmCalls, toolRows, modelRows, turns, facts };
}

/** A turn's tool calls in order, as `name` or `name!` for a failed call. */
export function toolSequence(turn: TurnDraft): string[] {
  return turn.steps
    .filter((step) => step.kind === "invoke")
    .map((step) => `${step.targetId}${step.outcome === "error" ? "!" : ""}`);
}

export { OTLP_MODEL_CALL };
