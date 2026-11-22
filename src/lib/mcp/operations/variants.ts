import { z } from "zod";
import { McpOperationError, notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, round, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, type WindowBounds, windowParams } from "@/lib/mcp/windows";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { variantExperimentsEnabled } from "@/lib/platform/variants-flag";
import {
  getVariantComparison,
  listVariantExperiments,
  type VariantComparisonResult,
  type VariantExperimentList,
} from "@/lib/views/variants/compare-service";
import type { VariantWindow } from "@/lib/views/variants/compare-store";
import type { Estimate, Rate, VariantMetrics } from "@/lib/views/variants/domain/compare";

/**
 * Variant experiments over MCP (RC-870): the experiments a project tags with
 * `ratel.variant.*`, and one experiment's per-variant comparison with 95%
 * intervals, its baseline, the minimum-sample warnings and the "cheaper model"
 * suggestion. The same read model as the console page, behind the same flag
 * (`FF_VARIANT_EXPERIMENTS`): off, both refuse with `forbidden`. Owned (ADR-0030):
 * the default gate passes the organization record to the core switch, not
 * upstream's ingest flag organization.
 */

const VARIANT_WINDOW: WindowBounds = { defaultDays: 7, maxDays: 30 };
const EXPERIMENTS_SHOWN = 50;
const ATTRS_SHOWN = 20;
const ATTR_CHARS = 200;

export interface VariantOperationDeps {
  getOrganization: (projectId: string) => Promise<Organization | null>;
  enabled: (projectId: string, organization: Organization) => Promise<boolean>;
  listVariantExperiments: (
    projectId: string,
    window: VariantWindow,
  ) => Promise<VariantExperimentList>;
  getVariantComparison: (
    projectId: string,
    experiment: string,
    window: VariantWindow,
  ) => Promise<VariantComparisonResult | null>;
  now: () => Date;
}

export const defaultVariantDeps: VariantOperationDeps = {
  getOrganization: (projectId) => getOrganizationByProjectId(projectId),
  enabled: (projectId, organization) => variantExperimentsEnabled(projectId, organization),
  listVariantExperiments: (projectId, window) => listVariantExperiments(projectId, window),
  getVariantComparison: (projectId, experiment, window) =>
    getVariantComparison(projectId, experiment, window),
  now: () => new Date(),
};

export function variantOperations(deps: VariantOperationDeps = defaultVariantDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_variant_experiments",
      domain: "observability",
      title: "List variant experiments",
      description:
        "The experiments this project tags on its traces with ratel.variant.experiment and ratel.variant.name, each with its variants and run counts, newest first. Open one with get_variant_experiment.",
      keywords: [
        "variant experiment",
        "variants",
        "model comparison",
        "prompt version",
        "ratel.variant",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams }),
      async execute(ctx, params) {
        await requireVariants(deps, ctx.projectId);
        const window = resolveWindow(params, VARIANT_WINDOW, deps.now());
        const list = await deps.listVariantExperiments(ctx.projectId, window);
        const shown = capRows(list.experiments, EXPERIMENTS_SHOWN);
        return {
          data: {
            experiments: shown.rows.map((experiment) => ({
              experiment: experiment.experiment,
              runs: experiment.runs,
              lastSeenAt: experiment.lastSeenAt,
              variants: experiment.variants,
            })),
          },
          truncated: list.truncated || shown.truncated,
          window: window.toJSON(),
          hint:
            list.experiments.length > 0
              ? "Compare the variants of one experiment with get_variant_experiment."
              : "No trace in this window carries ratel.variant.experiment and ratel.variant.name.",
        };
      },
    }),
    defineOperation({
      id: "get_variant_experiment",
      domain: "observability",
      title: "Compare an experiment's variants",
      description:
        "One variant experiment, per variant: runs, error rate, p50 and p95 latency, tokens, cost per successful trace, health signals and task scorer pass rate, each rate and figure with a 95% interval. Names the baseline, warns on variants under the minimum sample and suggests a cheaper variant whose quality stays inside the baseline's interval.",
      keywords: [
        "compare variants",
        "cheaper model",
        "variant baseline",
        "variant interval",
        "cost per success",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        experiment: z
          .string()
          .min(1)
          .max(200)
          .describe("An experiment name from list_variant_experiments."),
        ...windowParams,
      }),
      async execute(ctx, params) {
        await requireVariants(deps, ctx.projectId);
        const window = resolveWindow(params, VARIANT_WINDOW, deps.now());
        const result = await deps.getVariantComparison(ctx.projectId, params.experiment, window);
        if (!result) throw notFound("variant experiment with tagged traces in this window");
        const tracker = new TruncationTracker();
        tracker.mark(result.truncated);
        return {
          data: {
            experiment: result.experiment,
            baseline: result.baseline,
            minimumSample: result.minimumSample,
            variants: result.variants.map((variant) => variantView(variant, tracker)),
            suggestions: result.suggestions.map((suggestion) => ({
              ...suggestion,
              costPerSuccessUsd: round(suggestion.costPerSuccessUsd, 6),
              baselineCostPerSuccessUsd: round(suggestion.baselineCostPerSuccessUsd, 6),
              savingsFraction: round(suggestion.savingsFraction),
            })),
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint:
            result.suggestions.length > 0
              ? "A suggestion rests on the quality figures in qualityBasis; the scorer pass rate is computed from the task scorers over the sampled runs."
              : undefined,
        };
      },
    }),
  ];
}

async function requireVariants(deps: VariantOperationDeps, projectId: string): Promise<void> {
  const organization = await deps.getOrganization(projectId);
  if (!organization) throw notFound("project");
  if (!(await deps.enabled(projectId, organization))) {
    throw new McpOperationError(
      "forbidden",
      "Variant experiments are not available for this project.",
      { reason: "variant_experiments_off" },
    );
  }
}

function variantView(variant: VariantMetrics, tracker: TruncationTracker) {
  return {
    name: variant.name,
    attrs: boundedAttrs(variant.attrs, tracker),
    isBaseline: variant.isBaseline,
    runs: variant.runs,
    sampled: variant.sampled,
    errorRate: rateView(variant.errorRate),
    latencyP50Ms: estimateView(variant.latencyP50Ms, 1),
    latencyP95Ms: estimateView(variant.latencyP95Ms, 1),
    tokens: { ...variant.tokens, perRun: round(variant.tokens.perRun, 1) },
    costPerSuccessUsd: estimateView(variant.costPerSuccessUsd, 6),
    health: variant.health.map((signal) => ({ kind: signal.kind, ...rateView(signal.rate)! })),
    scorerPassRate: rateView(variant.scorerPassRate),
    warning: variant.warning,
  };
}

function rateView(rate: Rate | null) {
  return rate
    ? {
        value: round(rate.value),
        low: round(rate.interval.low),
        high: round(rate.interval.high),
        n: rate.n,
      }
    : null;
}

function estimateView(estimate: Estimate | null, places: number) {
  return estimate
    ? {
        value: round(estimate.value, places),
        low: round(estimate.interval.low, places),
        high: round(estimate.interval.high, places),
      }
    : null;
}

function boundedAttrs(
  attrs: Record<string, unknown>,
  tracker: TruncationTracker,
): Record<string, unknown> {
  const entries = Object.entries(attrs);
  tracker.mark(entries.length > ATTRS_SHOWN);
  return Object.fromEntries(
    entries
      .slice(0, ATTRS_SHOWN)
      .map(([key, value]) => [
        key,
        typeof value === "string" ? tracker.text(value, ATTR_CHARS) : value,
      ]),
  );
}
