import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import type {
  EventWithMetric,
  findStoredOtelSpans as findStoredOtelSpansFn,
  insertEventsWithMetrics as insertEventsWithMetricsFn,
  insertOtelSpans as insertOtelSpansFn,
  OtelSpanConflict,
} from "@/lib/ingest/otlp/queries";
import type { BatchPrices } from "@/lib/ingest/pricing";
import {
  FOLD_TRIGGER_TYPES,
  type IntentGraphFoldScheduleDeps,
  isOtlpFoldTrigger,
  scheduleIntentGraphFold,
} from "@/lib/ingest/trace-events/fold-schedule";
import type { insertTraceEvents as insertTraceEventsFn } from "@/lib/ingest/trace-events/queries";
import {
  scheduleTraceTurnBuild,
  type TraceTurnsIngestDeps,
} from "@/lib/ingest/trace-events/turns-schedule";
import type { LogError } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import { type AgentHealthBridgeDeps, agentHealthToolRows } from "./agent-health-bridge";
import { type AgentSpanDedupeDeps, resolveAgentSpanDedupe } from "./agent-span-dedupe";
import { attrString } from "./anyvalue";
import { indexSpans } from "./attr-resolve";
import { type ModelPricingIngestDeps, resolveBatchPrices } from "./batch-prices";
import { GEN_AI } from "./constants";
import { deriveGatewaySearches, deriveRatelSearches } from "./derive-search";
import { deriveSpanDimensions, NO_SPAN_DIMENSIONS, type SpanDimensionsById } from "./dimensions";
import { groupSpans } from "./group";
import { normalizeAiSdkSpans } from "./normalize-ai-sdk";
import { toRows } from "./reconstruct";
import type { FindRuntimeInvokes } from "./runtime-duplicates";
import { normalizeSemconvAliases } from "./semconv/aliases";
import { rejoinStoredModelCalls } from "./semconv/gen-ai-log-join";
import type { GenAiLogStore } from "./semconv/gen-ai-log-store";
import { attachGenAiLogEvents, distinctSpanKeys } from "./semconv/gen-ai-logs";
import { otelSpanRowId, toOtelSpanRows } from "./span-rows";
import type { DecodedSpan } from "./types";

/** Optional monthly-event counter; the entitlements port owns the real one. */
type IncrementEventUsage = (organizationId: string, n: number) => Promise<void>;

/**
 * Store decoded OTLP spans under a project: the half of trace ingest that
 * comes after authentication and decoding. `/v1/traces` calls it for every
 * export, and any other caller with decoded spans gets exactly the tables,
 * ledger rows and signals a live exporter produces.
 *
 * Every row id is deterministic, so storing the same spans twice adds no row.
 * Live ingest keeps what is stored (a retried export is a no-op); an import sets
 * `spanConflict: "update"` so a re-read import rewrites its stored spans.
 */

export interface PersistSpansContext {
  projectId: string;
  organization: Organization | null;
  /** The organization to count accepted events against; omitted, nothing is counted. */
  quotaOrgId?: string;
  /** The ingest lane, for failure reports: the OTLP route or the importer. */
  endpoint: string;
  /**
   * Kick the Cloud-built intent graph after a batch that left an ask or a tool
   * call. Live ingest sets it; the importer leaves it off, since a historical
   * import is thousands of rows at once and the cron drain's safety net folds
   * them paced, instead of one job per imported page.
   */
  foldIntentGraph?: boolean;
  /**
   * A raw span whose id is already stored: `ignore` (the default, live ingest)
   * keeps it; `update` (the Agent health importer) rewrites it with the new
   * values, so an import reprocessed after a mapper fix reaches `otel_spans`.
   */
  spanConflict?: OtelSpanConflict;
  /**
   * Meter the batch's traces: the port's `isMetered` for this organization, read by the caller.
   * Omitted or false, no trace is metered (the importer leaves it off).
   */
  meterTraces?: boolean;
  /**
   * When a queued export was accepted (ADR-0009): the clock for a span without a usable time, so
   * that a later or repeated run gives the same rows. Absent, now.
   */
  receivedAt?: Date;
  /**
   * The caller delivers the same batch again after a failure, so every failed write fails the
   * batch. Without it, the writes after the model calls are best effort.
   */
  redelivers?: boolean;
}

export interface PersistSpansDeps extends IntentGraphFoldScheduleDeps {
  insertEventsWithMetrics: typeof insertEventsWithMetricsFn;
  insertTraceEvents: typeof insertTraceEventsFn;
  insertOtelSpans: typeof insertOtelSpansFn;
  /** Which spans are stored, for an export that the meter refuses. Absent, none is looked up. */
  findStoredOtelSpans?: typeof findStoredOtelSpansFn;
  incrementEventUsage?: IncrementEventUsage;
  /** Decides each trace's outcome; used only when the context sets `meterTraces`. */
  traceMetering?: Pick<TraceMeteringPort, "meterTraceBatch" | "releaseSpans">;
  normalizeAiSdkSpans?: typeof normalizeAiSdkSpans;
  /** The span dimension derivation (`lib/ingest/otlp/dimensions`). Absent, the real one; a test passes one that throws. */
  deriveSpanDimensions?: typeof deriveSpanDimensions;
  traceTurns?: TraceTurnsIngestDeps;
  findRuntimeInvokes?: FindRuntimeInvokes;
  /** `toolRunInsights` for agent-run rows (RC-742). Absent, the switch is read. */
  agentRunsEnabled?: AgentHealthBridgeDeps["agentRunsEnabled"];
  /**
   * The agent-span dedupe's storage lookup: an agent wrapper with the run's
   * summed usage is not one more model call. `null` turns the dedupe off; only
   * the health importer passes it (lib/health-imports/start.ts).
   */
  agentSpanDedupe: AgentSpanDedupeDeps | null;
  /**
   * The project's own prices (RC-482), read once per batch: the batch pays
   * them and the current prices. Absent, the current built-in prices.
   */
  modelPricing?: ModelPricingIngestDeps;
  /**
   * The stored `gen_ai` log records of the batch's spans. Absent, none are read. With `findSpans` and `restateCalls`, a log
   * export stored while the batch was stored joins too.
   */
  genAiLogs?: Pick<GenAiLogStore, "findLogs"> &
    Partial<Pick<GenAiLogStore, "findSpans" | "restateCalls">>;
  logError: LogError;
  /** Report a processing failure that did not stop the batch (or did). */
  captureFailure: (error: unknown) => void;
}

/**
 * `rows`: the model call rows stored. `events`: the LLM-call rows failed.
 * `derived`: a batch of only ledger rows failed, or with `redelivers` any write after the LLM-call
 * rows. Either way, retry. `refused`: every span is over a bound of the edition. `refused` of a
 * stored batch: the spans that were. `dropped`: the spans of dropped traces.
 */
export type PersistSpansResult =
  | {
      ok: true;
      accepted: number;
      calls: number;
      rows: EventWithMetric[];
      refused?: number;
      dropped?: number;
    }
  | { ok: false; stage: "events" | "derived" | "refused" };

/** An OTLP trace id has 32 characters. Some exporters send their own, longer ones. */
const MAX_METERED_TRACE_ID = 256;

/** What a metered batch was admitted with, and what storage then found new. */
interface MeteredBatch {
  admitted: ReadonlyMap<string, number>;
  /** New rows of each trace in `otel_spans`. Null: not known, so nothing counts as resent. */
  newSpans: ReadonlyMap<string, number> | null;
  /** New model calls and ledger rows: a span id that was sent before can bring new ones. */
  newRows: number;
}

/**
 * Store a decoded batch. Spans that a meter admitted and that storage did not write (a failure, or
 * a resend of what is stored) are given back, so that each span counts once.
 */
export async function persistDecodedSpans(
  spans: DecodedSpan[],
  context: PersistSpansContext,
  deps: PersistSpansDeps,
): Promise<PersistSpansResult> {
  const batch: MeteredBatch = { admitted: new Map(), newSpans: null, newRows: 0 };
  const release = async (unstored: ReadonlyMap<string, number>) => {
    const { organization, projectId } = context;
    if (unstored.size === 0 || !organization) return;
    await deps.traceMetering
      ?.releaseSpans?.({ organization, projectId }, unstored)
      .catch((err: unknown) => {
        deps.logError("trace meter release failed", err, { project_id: projectId });
        deps.captureFailure(err);
      });
  };
  try {
    const result = await storeDecodedSpans(spans, context, deps, batch);
    await release(result.ok ? resentSpans(batch) : batch.admitted);
    return result;
  } catch (err) {
    await release(batch.admitted);
    throw err;
  }
}

/** The admitted spans of each trace that storage already held. */
function resentSpans({ admitted, newSpans, newRows }: MeteredBatch): Map<string, number> {
  const resent = new Map<string, number>();
  if (!newSpans) return resent;
  let left = total(admitted) - total(newSpans) - newRows;
  for (const [traceId, spans] of admitted) {
    const n = Math.min(left, spans - (newSpans.get(traceId) ?? 0));
    if (n <= 0) continue;
    resent.set(traceId, n);
    left -= n;
  }
  return resent;
}

function total(spans: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const n of spans.values()) sum += n;
  return sum;
}

async function storeDecodedSpans(
  spans: DecodedSpan[],
  {
    projectId,
    organization,
    quotaOrgId,
    endpoint,
    foldIntentGraph = false,
    spanConflict = "ignore",
    meterTraces = false,
    receivedAt,
    redelivers = false,
  }: PersistSpansContext,
  deps: PersistSpansDeps,
  batch: MeteredBatch,
): Promise<PersistSpansResult> {
  const { logError } = deps;
  // Speak one vocabulary downstream: additively re-key Vercel AI SDK `ai.*`
  // content onto the `gen_ai.*` semconv every consumer below already reads. A
  // no-op for spans that arrive translated (or never carried `ai.*` at all).
  // Fail open: this parses attacker-influenceable JSON, and a throw would 500 a
  // batch the exporter then retries forever. Degrading to untranslated spans
  // costs content segmentation, not the events themselves.
  try {
    (deps.normalizeAiSdkSpans ?? normalizeAiSdkSpans)(spans);
  } catch (err) {
    logError("ai sdk normalization failed", err, {
      project_id: projectId,
    });
    deps.captureFailure(err);
  }

  // Trace meters before anything is stored: a trace's first batch decides it for every later one.
  // A dropped trace stores nothing; an ingested-only one stores its spans and calls but writes no
  // analysis ledger rows, so no analysis job reads it. Best-effort: when the meter fails, the
  // batch is analyzed. A span without a trace id is in no trace, so it is never counted, and an
  // oversized id breaks the count of its whole batch. OTLP calls both invalid: they are not stored.
  const skipAnalysis = new Set<string>();
  let refused = 0;
  let dropped = 0;
  if (meterTraces && organization && deps.traceMetering) {
    spans = spans.filter(
      (span) => span.traceId.length > 0 && span.traceId.length <= MAX_METERED_TRACE_ID,
    );
    if (spans.length === 0) return { ok: true, accepted: 0, calls: 0, rows: [] };
    try {
      const outcomes = await deps.traceMetering.meterTraceBatch(
        { organization, projectId },
        spansByTrace(spans),
      );
      for (const [traceId, outcome] of outcomes)
        if (outcome !== "analyzed") skipAnalysis.add(traceId);
      const over = spans.filter((span) => outcomes.get(span.traceId) === "refused");
      // A resend of the export that filled the bound: what is stored is not refused, it is done.
      refused = over.length - (await countStored(over, projectId, deps));
      dropped = spans.filter((span) => outcomes.get(span.traceId) === "dropped").length;
      spans = spans.filter(
        (span) => !["dropped", "refused"].includes(outcomes.get(span.traceId) ?? ""),
      );
      batch.admitted = spansByTrace(spans);
      if (spans.length === 0) {
        if (refused > 0) return { ok: false, stage: "refused" };
        return { ok: true, accepted: 0, calls: 0, rows: [], ...(dropped > 0 ? { dropped } : {}) };
      }
    } catch (err) {
      logError("trace meter write failed", err, {
        organization_id: organization.id,
        project_id: projectId,
      });
      deps.captureFailure(err);
    }
  }
  const analyzedSpans =
    skipAnalysis.size === 0 ? spans : spans.filter((span) => !skipAnalysis.has(span.traceId));

  // Logs before spans: content sent as `gen_ai` log records that are already
  // stored joins its span as span events. Fail open: the call stays without them.
  let genAiLogsRead: number | null = null;
  if (deps.genAiLogs) {
    try {
      const logs = await deps.genAiLogs.findLogs(projectId, distinctSpanKeys(spans));
      genAiLogsRead = logs.length;
      attachGenAiLogEvents(spans, logs);
    } catch (err) {
      logError("gen_ai log lookup failed", err, { project_id: projectId });
      deps.captureFailure(err);
    }
  }
  // Deprecated gen_ai keys and OpenLLMetry aliases onto the canonical keys.
  // Fail open, like the AI SDK pass above.
  try {
    normalizeSemconvAliases(spans);
  } catch (err) {
    logError("semconv alias normalization failed", err, { project_id: projectId });
    deps.captureFailure(err);
  }

  // Which entity each span belongs to, decided one time for every row builder
  // below. Fail open: no builder derives it again, so when this throws the
  // batch is stored as before, with null dimension columns.
  let dimensions: SpanDimensionsById = NO_SPAN_DIMENSIONS;
  try {
    dimensions = (deps.deriveSpanDimensions ?? deriveSpanDimensions)(spans, indexSpans(spans));
  } catch (err) {
    logError("span dimension derivation failed", err, { project_id: projectId });
    deps.captureFailure(err);
  }

  const dedupe = deps.agentSpanDedupe
    ? await resolveAgentSpanDedupe(spans, projectId, deps.agentSpanDedupe, (err, traceIds) => {
        logError("agent span model call lookup failed", err, {
          project_id: projectId,
          trace_count: traceIds.length,
        });
        deps.captureFailure(err);
      })
    : undefined;

  // Group into LLM calls, reconstruct rows, and persist under the project.
  const calls = groupSpans(spans, dedupe);
  // RC-280: each call's payload keeps its own reply and settings for the session chat.
  const prices = await batchPrices(spans, projectId, deps);
  const rows = toRows(projectId, calls, { captureReply: true }, prices, receivedAt);

  let accepted = 0;
  if (rows.length > 0) {
    try {
      accepted = await deps.insertEventsWithMetrics(projectId, rows);
      batch.newRows += accepted;
    } catch (err) {
      logError("span insert failed", err, { project_id: projectId });
      deps.captureFailure(err);
      return { ok: false, stage: "events" };
    }
  }

  // Count the accepted events toward the monthly cap (best-effort; the boundary
  // batch is allowed and the next one is gated out, the same tolerance as embeddings).
  if (quotaOrgId && deps.incrementEventUsage && accepted > 0) {
    await deps.incrementEventUsage(quotaOrgId, accepted).catch((err) => {
      logError("event usage increment failed", err, {
        organization_id: quotaOrgId,
        project_id: projectId,
      });
    });
  }

  // Bridge OTel hosts into the intents pipeline: lift the search_capabilities
  // queries captured in message content into gateway_search trace events, and the
  // SDK funnel's anchor-less `ratel.search` spans into native search events (those
  // batches carry no LLM calls at all, so this must not hide behind rows.length).
  // Idempotent: every derived row's id is deterministic.
  const ratelDerived = deriveRatelSearches(analyzedSpans, receivedAt);
  // When the SDK's spans ride the same trace as the host's LLM call (capture on
  // for both), the same search appears twice in one batch: as a captured
  // search_capabilities tool_call AND as a ratel.search span. Keep the span row
  // (it's richer: hit_count, took_ms) and drop the message-derived duplicate.
  const sdkQueries = new Set(ratelDerived.map((r) => r.query).filter(Boolean));
  const derived = [
    ...rows
      .flatMap((r, index) =>
        r.event.payload && r.event.dedupeHash && !skipAnalysis.has(r.event.traceId ?? "")
          ? deriveGatewaySearches(r.event.payload, {
              dedupeHash: r.event.dedupeHash,
              occurredAt: r.event.occurredAt ?? r.metric.eventTime,
              endUserId: null,
              sourceId:
                attrString(calls[index]?.anchor.resourceAttributes ?? {}, "service.name") ?? null,
            })
          : [],
      )
      .filter((g) => !sdkQueries.has(g.query)),
    ...ratelDerived,
    // Agent health: the host's own tool-call spans as ledger invocations.
    ...(await agentHealthToolRows(
      analyzedSpans,
      projectId,
      {
        traceTurns: deps.traceTurns,
        findRuntimeInvokes: deps.findRuntimeInvokes,
        agentRunsEnabled: deps.agentRunsEnabled,
        logError,
      },
      dimensions,
      receivedAt,
    )),
  ];
  if (derived.length > 0) {
    try {
      const stored = await deps.insertTraceEvents(projectId, derived);
      batch.newRows += stored?.accepted ?? derived.length;
      // What the Cloud-built intent graph learns from: a plain agent trace's
      // ask or tool call, or a runtime's own search span exported this way.
      if (
        foldIntentGraph &&
        (stored?.accepted ?? derived.length) > 0 &&
        derived.some((event) => FOLD_TRIGGER_TYPES.has(event.type) || isOtlpFoldTrigger(event))
      ) {
        await scheduleIntentGraphFold(deps, projectId, endpoint);
      }
      await scheduleTraceTurnBuild(deps.traceTurns, {
        projectId: projectId,
        organization,
        eventTypes: derived.map((event) => event.type),
        accepted: stored?.accepted ?? derived.length,
        endpoint,
        logError,
      });
    } catch (err) {
      logError("derived search insert failed", err, {
        project_id: projectId,
      });
      deps.captureFailure(err);
      // With events rows stored, stay best-effort (their payloads keep the
      // queries, so a backfill can recover). But an anchor-less batch persists
      // ONLY these rows: fail loud so the exporter retries (inserts are
      // idempotent); swallowing would lose those searches forever.
      if (rows.length === 0 || redelivers) {
        return { ok: false, stage: "derived" };
      }
    }
  }

  // Raw spans are an additive observability tap. They do not count toward the
  // event quota and must never change the established ingest result.
  try {
    const spanRows = toOtelSpanRows(projectId, spans, dedupe, { prices, dimensions });
    if (spanRows.length > 0) {
      if (spanConflict === "update") {
        await deps.insertOtelSpans(projectId, spanRows, undefined, { onConflict: "update" });
      } else {
        const stored = await deps.insertOtelSpans(projectId, spanRows, undefined, {
          countByTrace: batch.admitted.size > 0,
        });
        batch.newSpans = stored?.acceptedByTrace ?? null;
      }
    }
  } catch (err) {
    logError("raw span insert failed", err, {
      project_id: projectId,
    });
    deps.captureFailure(err);
    if (redelivers) return { ok: false, stage: "derived" };
  }

  const rejoined = await rejoinLateGenAiLogs(
    spans,
    genAiLogsRead,
    projectId,
    organization,
    deps,
    receivedAt,
  );
  if (!rejoined && redelivers) return { ok: false, stage: "derived" };

  return {
    ok: true,
    accepted,
    calls: calls.length,
    rows,
    ...(refused > 0 ? { refused } : {}),
    ...(dropped > 0 ? { dropped } : {}),
  };
}

/** How many of these spans are stored already. Zero when they cannot be looked up. */
async function countStored(
  spans: readonly DecodedSpan[],
  projectId: string,
  deps: PersistSpansDeps,
): Promise<number> {
  if (spans.length === 0 || !deps.findStoredOtelSpans) return 0;
  try {
    const ids = spans.map((span) => otelSpanRowId(projectId, span));
    const stored = await deps.findStoredOtelSpans(
      projectId,
      [...new Set(ids)].map((id) => ({ id })),
    );
    return ids.filter((id) => stored.has(id)).length;
  } catch (err) {
    deps.logError("stored span lookup failed", err, { project_id: projectId });
    deps.captureFailure(err);
    return 0;
  }
}

/** How many spans the batch brings for each trace, in first-seen order. */
function spansByTrace(spans: readonly DecodedSpan[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { traceId } of spans) counts.set(traceId, (counts.get(traceId) ?? 0) + 1);
  return counts;
}

/**
 * A log export stored while this batch was stored: its restate read no
 * `otel_spans` yet, and this batch read no logs. Both sides store first and
 * read after, so at least one of them sees the other: here, more log records
 * than the first read means the export missed the call, so restate it.
 * Fails open, like the first read: false when it failed.
 */
async function rejoinLateGenAiLogs(
  spans: DecodedSpan[],
  logsRead: number | null,
  projectId: string,
  organization: Organization | null,
  deps: PersistSpansDeps,
  receivedAt: Date | undefined,
): Promise<boolean> {
  const { findLogs, findSpans, restateCalls } = deps.genAiLogs ?? {};
  if (logsRead === null || !findLogs || !findSpans || !restateCalls) return true;
  try {
    const logs = await findLogs(projectId, distinctSpanKeys(spans));
    if (logs.length <= logsRead) return true;
    await rejoinStoredModelCalls(projectId, organization, distinctSpanKeys(logs), {
      store: { findLogs, findSpans, restateCalls },
      ...(deps.modelPricing ? { modelPricing: deps.modelPricing } : {}),
      captureFailure: deps.captureFailure,
      ...(receivedAt ? { receivedAt } : {}),
    });
    return true;
  } catch (err) {
    deps.logError("gen_ai log rejoin failed", err, { project_id: projectId });
    deps.captureFailure(err);
    return false;
  }
}

/**
 * What this batch is priced with: the project's book, read only when the
 * batch has a model call; the current built-in prices (undefined) without
 * one. A failed price read stores no cost (`PRICES_UNKNOWN`) and logs the
 * error: a wrong cost would never be repaired, a missing one
 * `backfill:costs` prices later.
 */
async function batchPrices(
  spans: DecodedSpan[],
  projectId: string,
  deps: PersistSpansDeps,
): Promise<BatchPrices> {
  if (!deps.modelPricing) return undefined;
  const hasModel = spans.some(
    (span) =>
      attrString(span.attributes, GEN_AI.responseModel) ??
      attrString(span.attributes, GEN_AI.requestModel),
  );
  if (!hasModel) return undefined;
  return resolveBatchPrices(projectId, deps.modelPricing, {
    logError: deps.logError,
    captureFailure: deps.captureFailure,
  });
}
