import type {
  EventWithMetric,
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
import { agentHealthToolRows } from "./agent-health-bridge";
import { type AgentSpanDedupeDeps, resolveAgentSpanDedupe } from "./agent-span-dedupe";
import { attrString } from "./anyvalue";
import { type ModelPricingIngestDeps, resolveBatchPrices } from "./batch-prices";
import { GEN_AI } from "./constants";
import { deriveGatewaySearches, deriveRatelSearches } from "./derive-search";
import { groupSpans } from "./group";
import { normalizeAiSdkSpans } from "./normalize-ai-sdk";
import { toRows } from "./reconstruct";
import type { FindRuntimeInvokes } from "./runtime-duplicates";
import { normalizeSemconvAliases } from "./semconv/aliases";
import { rejoinStoredModelCalls } from "./semconv/gen-ai-log-join";
import type { GenAiLogStore } from "./semconv/gen-ai-log-store";
import { attachGenAiLogEvents, distinctSpanKeys } from "./semconv/gen-ai-logs";
import { toOtelSpanRows } from "./span-rows";
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
}

export interface PersistSpansDeps extends IntentGraphFoldScheduleDeps {
  insertEventsWithMetrics: typeof insertEventsWithMetricsFn;
  insertTraceEvents: typeof insertTraceEventsFn;
  insertOtelSpans: typeof insertOtelSpansFn;
  incrementEventUsage?: IncrementEventUsage;
  normalizeAiSdkSpans?: typeof normalizeAiSdkSpans;
  traceTurns?: TraceTurnsIngestDeps;
  findRuntimeInvokes?: FindRuntimeInvokes;
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
 * `derived`: a batch of only ledger rows failed. Either way, retry.
 */
export type PersistSpansResult =
  | { ok: true; accepted: number; calls: number; rows: EventWithMetric[] }
  | { ok: false; stage: "events" | "derived" };

export async function persistDecodedSpans(
  spans: DecodedSpan[],
  {
    projectId,
    organization,
    quotaOrgId,
    endpoint,
    foldIntentGraph = false,
    spanConflict = "ignore",
  }: PersistSpansContext,
  deps: PersistSpansDeps,
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
  const rows = toRows(projectId, calls, { captureReply: true }, prices);

  let accepted = 0;
  if (rows.length > 0) {
    try {
      accepted = await deps.insertEventsWithMetrics(projectId, rows);
    } catch (err) {
      logError("span insert failed", err, { project_id: projectId });
      deps.captureFailure(err);
      return { ok: false, stage: "events" };
    }
  }

  // Bridge OTel hosts into the intents pipeline: lift the search_capabilities
  // queries captured in message content into gateway_search trace events, and the
  // SDK funnel's anchor-less `ratel.search` spans into native search events (those
  // batches carry no LLM calls at all, so this must not hide behind rows.length).
  // Idempotent: every derived row's id is deterministic.
  const ratelDerived = deriveRatelSearches(spans);
  // When the SDK's spans ride the same trace as the host's LLM call (capture on
  // for both), the same search appears twice in one batch: as a captured
  // search_capabilities tool_call AND as a ratel.search span. Keep the span row
  // (it's richer: hit_count, took_ms) and drop the message-derived duplicate.
  const sdkQueries = new Set(ratelDerived.map((r) => r.query).filter(Boolean));
  const derived = [
    ...rows
      .flatMap((r, index) =>
        r.event.payload && r.event.dedupeHash
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
    ...(await agentHealthToolRows(spans, projectId, {
      traceTurns: deps.traceTurns,
      findRuntimeInvokes: deps.findRuntimeInvokes,
      logError,
    })),
  ];
  if (derived.length > 0) {
    try {
      const stored = await deps.insertTraceEvents(projectId, derived);
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
      if (rows.length === 0) {
        return { ok: false, stage: "derived" };
      }
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

  // Raw spans are an additive observability tap. They do not count toward the
  // event quota and must never change the established ingest result.
  try {
    const spanRows = toOtelSpanRows(projectId, spans, dedupe, { prices });
    if (spanRows.length > 0) {
      if (spanConflict === "update") {
        await deps.insertOtelSpans(projectId, spanRows, undefined, { onConflict: "update" });
      } else {
        await deps.insertOtelSpans(projectId, spanRows);
      }
    }
  } catch (err) {
    logError("raw span insert failed", err, {
      project_id: projectId,
    });
    deps.captureFailure(err);
  }

  await rejoinLateGenAiLogs(spans, genAiLogsRead, projectId, organization, deps);

  return { ok: true, accepted, calls: calls.length, rows };
}

/**
 * A log export stored while this batch was stored: its restate read no
 * `otel_spans` yet, and this batch read no logs. Both sides store first and
 * read after, so at least one of them sees the other: here, more log records
 * than the first read means the export missed the call, so restate it.
 * Fails open, like the first read.
 */
async function rejoinLateGenAiLogs(
  spans: DecodedSpan[],
  logsRead: number | null,
  projectId: string,
  organization: Organization | null,
  deps: PersistSpansDeps,
): Promise<void> {
  const { findLogs, findSpans, restateCalls } = deps.genAiLogs ?? {};
  if (logsRead === null || !findLogs || !findSpans || !restateCalls) return;
  try {
    const logs = await findLogs(projectId, distinctSpanKeys(spans));
    if (logs.length <= logsRead) return;
    await rejoinStoredModelCalls(projectId, organization, distinctSpanKeys(logs), {
      store: { findLogs, findSpans, restateCalls },
      ...(deps.modelPricing ? { modelPricing: deps.modelPricing } : {}),
      captureFailure: deps.captureFailure,
    });
  } catch (err) {
    deps.logError("gen_ai log rejoin failed", err, { project_id: projectId });
    deps.captureFailure(err);
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
