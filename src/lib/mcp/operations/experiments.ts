import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  experimentAttributesFor,
  mayReadContent,
  readContentOptIn,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, round, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import type { SelectionDetail } from "@/lib/synthesis/experiments/calibration-types";
import {
  buildSelectionRankingView,
  selectionQuery,
} from "@/lib/synthesis/experiments/selection-view";
import type { ExperimentLifecycleData } from "@/lib/synthesis/experiments/service";
import {
  createExperimentService,
  type ExperimentWindow,
} from "@/lib/synthesis/experiments/service";
import { loadExperimentDetailSurface } from "@/lib/synthesis/experiments/surface-loaders";
import type {
  ComparedArm,
  ExperimentComparison,
  ExperimentConversionMetrics,
  MetricDelta,
} from "@/lib/synthesis/experiments/types";
import { getSelectionDetail } from "@/lib/synthesis/traces/experiment-calibration-queries";
import { createExperimentQueries } from "@/lib/synthesis/traces/experiment-queries";

/**
 * Experiments over MCP: one experiment's detail page (per-arm numbers, how
 * each arm compares with the baseline, which capabilities moved rank, the
 * issues detected, the shadow lifecycle and conversion), and the selection
 * inspector (one shadow-tested search with both rankings).
 *
 * The reads are the console's, under the same statement timeouts, with the
 * lifecycle and conversion panels degrading on their own as they do there.
 * A selection's query is an end user's words and its lifecycle records carry
 * raw attributes, so both are truncated and capped, and the query (on its own
 * or as a record attribute) is returned only to a caller that may read
 * captured text (`mayReadContent`).
 */
const CAPABILITY_ROWS = 25;
const RESULTS_SHOWN = 20;
const QUERY_CHARS = 2_000;
const RECORDS_SHOWN = 20;
const ATTRIBUTES_PER_RECORD = 30;
const ATTRIBUTE_CHARS = 200;
const ATTRIBUTE_ITEMS = 10;

export interface ExperimentOperationDeps extends ContentAccessDeps {
  getExperimentComparison: (
    projectId: string,
    name: string,
    window: ExperimentWindow,
  ) => Promise<ExperimentComparison | null>;
  getExperimentLifecycle: (
    projectId: string,
    name: string,
    window: ExperimentWindow,
  ) => Promise<ExperimentLifecycleData | null>;
  getExperimentConversion: (
    projectId: string,
    name: string,
    window: ExperimentWindow,
  ) => Promise<ExperimentConversionMetrics | null>;
  getSelectionDetail: (projectId: string, selectionId: string) => Promise<SelectionDetail | null>;
}

const service = (db: Parameters<typeof createExperimentQueries>[0]) =>
  createExperimentService(createExperimentQueries(db));

export const defaultExperimentDeps: ExperimentOperationDeps = {
  getExperimentComparison: (projectId, name, window) =>
    withStatementTimeout((db) => service(db).getExperimentComparison(projectId, name, window), {
      operation: "experiment_comparison",
    }),
  getExperimentLifecycle: (projectId, name, window) =>
    withStatementTimeout((db) => service(db).getExperimentLifecycle(projectId, name, window), {
      operation: "experiment_lifecycle",
      timeoutMs: supplementaryReadTimeoutMs(),
    }),
  getExperimentConversion: (projectId, name, window) =>
    withStatementTimeout((db) => service(db).getExperimentConversion(projectId, name, window), {
      operation: "experiment_conversion",
      timeoutMs: supplementaryReadTimeoutMs(),
    }),
  getSelectionDetail: (projectId, selectionId) =>
    withStatementTimeout((db) => getSelectionDetail(projectId, selectionId, db), {
      operation: "calibration_selection_detail",
    }),
  contentOptIn: readContentOptIn,
};

function delta(value: MetricDelta | null | undefined) {
  if (!value) return null;
  return { absolute: round(value.absolute), relative: round(value.relative) };
}

function armView(arm: ComparedArm, baselineArm: string) {
  const { metrics } = arm;
  return {
    arm: arm.arm,
    baseline: arm.arm === baselineArm,
    traces: metrics.traceCount,
    errors: metrics.errorTraceCount,
    errorRate: round(metrics.errorRate),
    latencyMs: {
      average: round(metrics.averageLatencyMs, 1),
      p50: round(metrics.p50LatencyMs, 1),
      p95: round(metrics.p95LatencyMs, 1),
    },
    tokens: {
      averageInput: round(metrics.averageInputTokens, 1),
      averageOutput: round(metrics.averageOutputTokens, 1),
    },
    averageCostUsd: round(metrics.averageCostUsd, 6),
    averageSearches: round(metrics.averageSearchCount, 2),
    averageSearchHits: round(metrics.averageSearchHitCount, 2),
    // Against the baseline arm; null on the baseline itself.
    vsBaseline: arm.deltas
      ? {
          errorRate: delta(arm.deltas.errorRate),
          averageLatencyMs: delta(arm.deltas.averageLatencyMs),
          p95LatencyMs: delta(arm.deltas.p95LatencyMs),
          averageInputTokens: delta(arm.deltas.averageInputTokens),
          averageOutputTokens: delta(arm.deltas.averageOutputTokens),
          averageCostUsd: delta(arm.deltas.averageCostUsd),
          averageSearchHits: delta(arm.deltas.averageSearchHitCount),
        }
      : null,
    ...(arm.lifecycle
      ? {
          shadow: {
            comparisons: arm.lifecycle.comparisonCount,
            top1Rate: round(arm.lifecycle.top1Rate),
            exactOrderRate: round(arm.lifecycle.exactOrderRate),
            averageMatchScore: round(arm.lifecycle.averageJaccardAtK),
            k: arm.lifecycle.agreementK,
            skipped: arm.lifecycle.skipCount,
            fellBack: arm.lifecycle.fallbackCount,
            dropped: arm.lifecycle.dropCount,
            dropsByReason: arm.lifecycle.dropsByReason,
            coverage: round(arm.lifecycle.shadowCoverage),
          },
        }
      : {}),
    ...(arm.conversion
      ? {
          conversion: {
            outcomes: arm.conversion.outcomeCount,
            outcomesByLabel: arm.conversion.outcomesByLabel,
            averageOutcomeScore: round(arm.conversion.averageOutcomeScore),
            invocations: arm.conversion.invocationCount,
            servedInvocations: arm.conversion.servedInvocationCount,
            notServedInvocations: arm.conversion.notServedInvocationCount,
            invocationRankHistogram: arm.conversion.invocationRankHistogram,
          },
        }
      : {}),
  };
}

/** One attribute value, bounded: long strings cut, arrays shortened, nested objects summarized. */
function boundedValue(value: unknown, tracker: TruncationTracker): unknown {
  if (typeof value === "string") return tracker.text(value, ATTRIBUTE_CHARS);
  if (Array.isArray(value)) {
    const items = tracker.take(capRows(value, ATTRIBUTE_ITEMS));
    return items.map((item) =>
      typeof item === "string"
        ? tracker.text(item, ATTRIBUTE_CHARS)
        : typeof item === "object" && item !== null
          ? "[object]"
          : item,
    );
  }
  if (typeof value === "object" && value !== null) {
    tracker.mark(true);
    return "[object]";
  }
  return value;
}

function boundedAttributes(
  attrs: Readonly<Record<string, unknown>>,
  tracker: TruncationTracker,
): Record<string, unknown> {
  const entries = tracker.take(capRows(Object.entries(attrs), ATTRIBUTES_PER_RECORD));
  return Object.fromEntries(entries.map(([key, value]) => [key, boundedValue(value, tracker)]));
}

function rankedResults(ids: string[] | null, scores: number[] | null, tracker: TruncationTracker) {
  if (!ids) return null;
  return tracker.take(capRows(ids, RESULTS_SHOWN)).map((id, index) => ({
    rank: index + 1,
    id,
    score: round(scores?.[index] ?? null),
  }));
}

export function experimentOperations(
  deps: ExperimentOperationDeps = defaultExperimentDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "get_experiment",
      domain: "observability",
      title: "Experiment detail",
      description:
        "One experiment over a window: per-arm traces, errors, latency, tokens and cost, each arm against the baseline, the capabilities whose rank moved, detected issues, shadow agreement and reliability, and conversion. Find names with list_calibrations; drill into disagreements with list_calibration_mismatches.",
      keywords: [
        "experiment",
        "per-arm numbers",
        "a/b",
        "variant",
        "compare arms",
        "arm latency",
        "arm cost",
        "conversion",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        experimentName: z
          .string()
          .min(1)
          .max(256)
          .describe("Experiment name, as returned by list_calibrations."),
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.entities);
        const bounds = { since: window.since, until: window.until };
        const name = params.experimentName;
        const comparison = await loadExperimentDetailSurface(
          { distinctId: `project:${ctx.projectId}` },
          {
            loadComparison: () => deps.getExperimentComparison(ctx.projectId, name, bounds),
            loadLifecycle: () => deps.getExperimentLifecycle(ctx.projectId, name, bounds),
            loadConversion: () => deps.getExperimentConversion(ctx.projectId, name, bounds),
          },
        );
        if (!comparison) throw notFound("experiment");

        const tracker = new TruncationTracker();
        const moved = [...comparison.capabilities.rows].sort(
          (a, b) =>
            Math.abs(b.maxAbsoluteRankDelta ?? 0) - Math.abs(a.maxAbsoluteRankDelta ?? 0) ||
            a.id.localeCompare(b.id),
        );
        const capabilities = tracker.take(capRows(moved, CAPABILITY_ROWS));
        return {
          data: {
            name: comparison.name,
            mode: comparison.mode,
            baselineArm: comparison.baselineArm,
            arms: comparison.arms.map((arm) => armView(arm, comparison.baselineArm)),
            issues: comparison.issues.map((issue) => ({
              kind: issue.kind,
              severity: issue.severity,
              arm: issue.arm,
              message: issue.message,
            })),
            capabilityRanks: {
              hasRankings: comparison.capabilities.hasRankings,
              total: comparison.capabilities.rows.length,
              // Largest rank change first: the rows worth explaining.
              rows: capabilities.map((row) => ({
                type: row.type,
                id: row.id,
                baselineAppearances: row.baselineAppearances,
                baselineAverageRank: round(row.baselineAverageRank, 2),
                maxRankChange: round(row.maxAbsoluteRankDelta, 2),
                arms: row.arms.map((arm) => ({
                  arm: arm.arm,
                  appearances: arm.appearances,
                  averageRank: round(arm.averageRank, 2),
                  rankChange: round(arm.rankDelta, 2),
                  absent: arm.absent,
                })),
              })),
              reportedHits: comparison.capabilities.reportedHitMetrics.map((metric) => ({
                arm: metric.arm,
                total: metric.total,
                searches: metric.searchSpanCount,
                averagePerSearch: round(metric.averagePerSearch, 2),
              })),
            },
            lifecycle: comparison.lifecycleDiagnostics
              ? {
                  hasLifecycleEvents: comparison.lifecycleDiagnostics.hasLifecycleEvents,
                  latestLogAt: comparison.lifecycleDiagnostics.latestLogAt?.toISOString() ?? null,
                }
              : null,
            conversion: comparison.conversionSummary
              ? {
                  ...comparison.conversionSummary,
                  invocationAttributionRate: round(
                    comparison.conversionSummary.invocationAttributionRate,
                  ),
                }
              : null,
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint: comparison.issues.length
            ? "Start with the issues. For ranking disagreements, list_calibration_mismatches lists the queries, and get_selection opens one."
            : "No issues detected. list_calibration_mismatches lists any queries where the arms ranked differently.",
        };
      },
    }),
    defineOperation({
      id: "get_selection",
      domain: "observability",
      title: "Selection inspector",
      description:
        "One shadow-tested search in full: the query, both arms' rankings with scores, how far they agreed at k, each arm's outcome and duration, its trace id, and its lifecycle records. Take a selectionId from list_calibration_mismatches or get_quality; reproduce it with test_retrieval.",
      keywords: [
        "selection",
        "inspector",
        "both rankings",
        "served",
        "shadow ranking",
        "scores",
        "one search",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        selectionId: z
          .string()
          .min(1)
          .max(200)
          .describe("A selectionId from list_calibration_mismatches or get_quality."),
      }),
      async execute(ctx, params) {
        const detail = await deps.getSelectionDetail(ctx.projectId, params.selectionId);
        if (!detail) throw notFound("selection");
        const content = await mayReadContent(ctx, deps);

        const tracker = new TruncationTracker();
        const ranking = buildSelectionRankingView(detail.records);
        // Off any record that carries it: a skipped or dropped shadow has no
        // comparison, and those are the selections worth reproducing.
        const query = ranking?.query ?? selectionQuery(detail.records);
        const records = tracker.take(capRows(detail.records, RECORDS_SHOWN));
        return {
          data: {
            selectionId: detail.selectionId,
            experimentName: detail.experimentName,
            traceId: detail.traceId,
            // Whether get_trace can open it: a sampled-out trace has no spans.
            traceKept: detail.traceHasSpans,
            query: !content || query === null ? null : tracker.text(query, QUERY_CHARS),
            ranking: ranking
              ? {
                  occurredAt: ranking.occurredAt.toISOString(),
                  k: ranking.agreementK,
                  sameTop1: ranking.top1,
                  sameOrder: ranking.exactOrder,
                  overlap: ranking.overlapCount,
                  matchScore: round(ranking.jaccardAtK),
                  served: {
                    arm: ranking.servedArm,
                    outcome: ranking.servedOutcome,
                    durationMs: round(ranking.servedDurationMs, 1),
                    hits: ranking.servedHitCount,
                    results: rankedResults(
                      ranking.servedResultIds,
                      ranking.servedResultScores,
                      tracker,
                    ),
                  },
                  shadow: {
                    arm: ranking.shadowArm,
                    outcome: ranking.shadowOutcome,
                    durationMs: round(ranking.shadowDurationMs, 1),
                    hits: ranking.shadowHitCount,
                    results: rankedResults(
                      ranking.shadowResultIds,
                      ranking.shadowResultScores,
                      tracker,
                    ),
                  },
                }
              : null,
            recordCount: detail.records.length,
            records: records.map((record) => ({
              event: record.eventName,
              occurredAt: record.occurredAt.toISOString(),
              arm: record.arm,
              role: record.role,
              attributes: boundedAttributes(
                experimentAttributesFor(record.experimentAttrs, content),
                tracker,
              ),
            })),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            ranking
              ? "Reproduce the query with test_retrieval to test a description change against it."
              : "No comparison was recorded for this selection (the shadow was skipped or dropped); the lifecycle records say why.",
          ),
        };
      },
    }),
  ];
}
