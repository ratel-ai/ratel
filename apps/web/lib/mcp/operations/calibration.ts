import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, round, truncateText } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { createCalibrationQueries } from "@/lib/synthesis/experiments/calibration-queries";
import {
  createCalibrationService,
  type RankingComparisonListOptions,
} from "@/lib/synthesis/experiments/calibration-service";
import type {
  ArmPairAgreementSummary,
  RankingComparisonRowView,
} from "@/lib/synthesis/experiments/calibration-types";
import { createExperimentService } from "@/lib/synthesis/experiments/service";
import { COMPARISON_FACETS } from "@/lib/synthesis/traces/calibration-view";
import { createExperimentQueries } from "@/lib/synthesis/traces/experiment-queries";

/**
 * Calibration: where the retrieval engine and its shadow disagreed.
 *
 * This is the surface an agent most needs and could least reconstruct. A
 * mismatch is a recorded fact about production ("for this real query, the arm
 * that served returned a different ranking than the arm under test"), and no
 * amount of reading skills tells you which queries those were. Everything else
 * on this MCP surface describes the catalog as it is; this describes where it
 * behaves differently from what was expected.
 *
 * Rows are read from `otel_logs`, one record per shadow-tested selection, so
 * they are a census rather than a sample even when trace sampling is on.
 *
 * Serialization is aggressive. A comparison row carries two ranked result lists
 * and their score vectors; the scores are dropped and the id lists capped,
 * because an agent diagnosing a disagreement needs to know *which* capabilities
 * swapped and by how much the rankings differ, not the raw float behind each
 * position. The diff summary already carries the magnitude.
 */
const RESULT_ID_CAP = 10;
const QUERY_PREVIEW_CHARS = 200;

export interface CalibrationOperationDeps {
  listExperiments: ReturnType<typeof createExperimentService>["listExperiments"];
  resolveCalibrationSummaries: ReturnType<
    typeof createCalibrationService
  >["resolveCalibrationSummaries"];
  getRankingCalibration: ReturnType<typeof createCalibrationService>["getRankingCalibration"];
  listComparisonPage: ReturnType<typeof createCalibrationService>["listComparisonPage"];
}

export const defaultCalibrationDeps: CalibrationOperationDeps = {
  listExperiments: (...args) =>
    createExperimentService(createExperimentQueries()).listExperiments(...args),
  resolveCalibrationSummaries: (...args) =>
    createCalibrationService(createCalibrationQueries()).resolveCalibrationSummaries(...args),
  getRankingCalibration: (...args) =>
    createCalibrationService(createCalibrationQueries()).getRankingCalibration(...args),
  listComparisonPage: (...args) =>
    createCalibrationService(createCalibrationQueries()).listComparisonPage(...args),
};

/** A rate is only meaningful next to the count it was computed from. */
function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : round(part / whole, 4);
}

function summarizePair(pair: ArmPairAgreementSummary) {
  return {
    servedArm: pair.servedArm,
    shadowArm: pair.shadowArm,
    comparisonCount: pair.comparisonCount,
    mismatchCount: pair.mismatchCount,
    mismatchRate: rate(pair.mismatchCount, pair.comparisonCount),
    top1Rate: round(pair.top1Rate),
    exactOrderRate: round(pair.exactOrderRate),
    averageMatchScore: round(pair.averageJaccardAtK),
  };
}

function summarizeComparison(row: RankingComparisonRowView) {
  const served = capRows(row.servedResultIds ?? [], RESULT_ID_CAP);
  const shadow = capRows(row.shadowResultIds ?? [], RESULT_ID_CAP);
  return {
    selectionId: row.selectionId,
    occurredAt: row.occurredAt.toISOString(),
    traceId: row.traceId,
    query: truncateText(row.query, QUERY_PREVIEW_CHARS).text,
    servedArm: row.servedArm,
    shadowArm: row.shadowArm,
    servedOutcome: row.servedOutcome,
    shadowOutcome: row.shadowOutcome,
    // Both rankings, because "they disagreed" is not actionable without
    // knowing what each one actually returned.
    servedResultIds: served.rows,
    shadowResultIds: shadow.rows,
    sameTop1: row.top1,
    sameOrder: row.exactOrder,
    matchScore: round(row.matchScore),
    // How the two rankings differ, in the same vocabulary the Playground diff
    // uses, so a recorded mismatch and a what-if run read alike.
    diff: row.diffSummary,
    latencyDeltaMs:
      row.servedDurationMs !== null && row.shadowDurationMs !== null
        ? round(row.shadowDurationMs - row.servedDurationMs, 1)
        : null,
  };
}

export function calibrationOperations(
  deps: CalibrationOperationDeps = defaultCalibrationDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_calibrations",
      domain: "observability",
      title: "List calibrations",
      description:
        "Experiments in this project that recorded ranking comparisons, with how many selections were compared and how many disagreed. The starting point for calibration work: find the experiment with a mismatch rate worth explaining, then open it with get_calibration.",
      keywords: ["calibration", "experiment", "shadow", "arms", "which experiment"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams, limit: limitParam }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.entities);
        const bounds = { since: window.since, until: window.until };

        const experiments = await deps.listExperiments(ctx.projectId, bounds);
        if (experiments.length === 0) {
          return {
            data: { count: 0, calibrations: [] },
            window: window.toJSON(),
            hint: "No experiments reported telemetry in this window. Widen the window, or check that the SDK is exporting experiment arms.",
          };
        }

        const summaries = await deps.resolveCalibrationSummaries(
          ctx.projectId,
          experiments.map(({ name }) => name),
          bounds,
        );

        const rows = experiments
          .map((experiment) => {
            const summary = summaries.get(experiment.name);
            const comparisonCount = summary?.comparisonCount ?? 0;
            const mismatchCount = summary?.mismatchCount ?? 0;
            return {
              name: experiment.name,
              kind: summary?.kind ?? "generic",
              comparisonCount,
              mismatchCount,
              mismatchRate: rate(mismatchCount, comparisonCount),
              lastSeenAt: experiment.lastSeenAt.toISOString(),
            };
          })
          // Most disagreement first: that is the row worth opening.
          .sort((a, b) => b.mismatchCount - a.mismatchCount || a.name.localeCompare(b.name));

        const page = capRows(rows, params.limit);
        const comparable = rows.filter((row) => row.kind === "ranking-shadow").length;
        return {
          data: { count: page.rows.length, total: rows.length, calibrations: page.rows },
          truncated: page.truncated,
          window: window.toJSON(),
          hint: comparable
            ? "Open one with get_calibration, then list_calibration_mismatches for the individual queries that disagreed."
            : "No experiment here exports ranking comparisons, so there is nothing to calibrate against yet.",
        };
      },
    }),
    defineOperation({
      id: "get_calibration",
      domain: "observability",
      title: "Calibration detail",
      description:
        "How two arms of one experiment agreed over a window: per-arm-pair comparison counts, mismatch counts, top-1 and exact-order agreement rates, and a sample of recent comparisons. Use list_calibration_mismatches to see only the ones that disagreed.",
      keywords: ["calibration", "agreement", "arms", "top1", "parity", "experiment"],
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
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.entities);
        const view = await deps.getRankingCalibration(
          ctx.projectId,
          params.experimentName,
          { since: window.since, until: window.until },
          { limit: params.limit },
        );
        // Null means no comparison records at all, which is indistinguishable
        // here from an experiment that does not exist: neither is something the
        // caller can act on, and telling them apart would report an empty
        // window as a missing experiment.
        if (!view) throw notFound("calibration");

        const comparisons = capRows(view.comparisons, params.limit);
        return {
          data: {
            name: view.name,
            kind: view.kind,
            comparisonCount: view.totalComparisonCount,
            mismatchCount: view.mismatchCount,
            mismatchRate: rate(view.mismatchCount, view.totalComparisonCount),
            armPairs: view.pairs.map(summarizePair),
            arms: view.arms.map((arm) => ({
              arm: arm.arm,
              servingCount: arm.servingCount,
              shadowingCount: arm.shadowingCount,
            })),
            recentComparisons: comparisons.rows.map(summarizeComparison),
          },
          truncated: comparisons.truncated,
          window: window.toJSON(),
          hint: view.mismatchCount
            ? "Call list_calibration_mismatches for the queries that disagreed, then test_retrieval on one of them to test a fix."
            : "Every compared selection agreed in this window.",
        };
      },
    }),
    defineOperation({
      id: "list_calibration_mismatches",
      domain: "observability",
      title: "Calibration mismatches",
      description:
        "The individual real queries where two arms returned different rankings, with both rankings and how they differ. This is the concrete work list for improving retrieval: take a query from here, reproduce it with test_retrieval, and test a description change against it.",
      keywords: [
        "where retrieval disagreed",
        "mismatch",
        "misaligned",
        "top issues",
        "regression",
        "calibration",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        experimentName: z.string().min(1).max(256),
        facets: z
          .array(z.enum(COMPARISON_FACETS))
          .max(COMPARISON_FACETS.length)
          .optional()
          .describe("Narrow to particular kinds of disagreement."),
        includeAgreements: z
          .boolean()
          .default(false)
          .describe("Also return selections where the two arms agreed."),
        limit: limitParam,
        offset: z.number().int().min(0).default(0),
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.entities);
        const options: RankingComparisonListOptions = {
          selection: {
            scope: params.includeAgreements ? "all" : "mismatch",
            facets: params.facets ? [...params.facets] : [],
            match: "any",
          },
          limit: params.limit,
          offset: params.offset,
        };

        const page = await deps.listComparisonPage(
          ctx.projectId,
          params.experimentName,
          { since: window.since, until: window.until },
          options,
        );

        const rows = capRows(page.rows, params.limit);
        return {
          data: {
            experimentName: params.experimentName,
            count: rows.rows.length,
            total: page.total,
            offset: params.offset,
            comparisons: rows.rows.map(summarizeComparison),
          },
          truncated: rows.truncated || page.total > params.offset + rows.rows.length,
          window: window.toJSON(),
          hint: page.total
            ? "Reproduce one of these queries with test_retrieval to see whether a description change would fix the ranking."
            : "Nothing matched. Widen the window, drop the facets, or set includeAgreements to see the full comparison stream.",
        };
      },
    }),
  ];
}
