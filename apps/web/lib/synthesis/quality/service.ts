import { and, eq, inArray } from "drizzle-orm";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import { organizations } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import {
  type AnswerCoverage,
  type ArmRanking,
  ATTRIBUTION_NOTES,
  type AttributionMode,
  BIAS_NOTES,
  byArm,
  type EvaluableSelection,
  type EvidenceTier,
  type FollowThroughReport,
  followThrough,
  observeSelections,
  observeUnified,
  pickBaselineArm,
  type RevealedBias,
  revealedArmBias,
  summarizeAnswers,
} from "@/lib/synthesis/quality/ground-truth";

export { type AnswerCoverage, summarizeAnswers } from "@/lib/synthesis/quality/ground-truth";

import {
  type CatalogInventory,
  loadCatalogInventory,
} from "@/lib/ingest/runtime-catalog/inventory";
import {
  type CoverageSample,
  type CoverageScore,
  type ListCost,
  type ListCostSample,
  type QualityScore,
  scoreCoverage,
  scoreObservations,
  scoreUnified,
  separated,
  summarizeListCost,
  type UnifiedScore,
} from "@/lib/synthesis/quality/metrics";
import {
  listQualityCalibrations,
  listQualityProjects,
  loadEvaluableSelections,
  type QualitySelectionDiagnostics,
} from "@/lib/synthesis/quality/queries";
import {
  catalogPromptTokens,
  estimateSavings,
  speedup,
  type TokenSavings,
} from "@/lib/synthesis/quality/tokens";

/**
 * Assembling the quality view: one read of a calibration's window, scored every
 * way the surface shows it.
 *
 * The two evidence tiers are computed side by side and never merged. A caller
 * gets both, each with its own `n`, and the surface is responsible for making
 * the reader see which one they are looking at.
 */

export interface ArmLatency {
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Share of this arm's searches that errored or timed out. */
  errorRate: number | null;
  samples: number;
}

/** One arm, scored under one tier. */
export interface ArmQuality {
  arm: string;
  role: "serving" | "shadow" | "mixed" | null;
  score: QualityScore;
  bias: RevealedBias;
  biasNote: string;
  /** True when this arm's containment is distinguishable from the baseline's. */
  separatedFromBaseline: boolean;
}

export interface TierQuality {
  tier: EvidenceTier;
  baselineArm: string | null;
  arms: ArmQuality[];
  /**
   * False when the arms were scored over different populations, so their
   * numbers are each honest but must not be read against one another.
   */
  comparable: boolean;
  /** Why, in one sentence, when the tier needs explaining. */
  note?: string;
}

export interface QualityView {
  projectId: string;
  projectName: string;
  projectSlug: string;
  organizationName: string | null;
  experimentName: string;
  window: ExperimentWindow;
  tiers: TierQuality[];
  /** How much of the window has a known answer; every accuracy is over `answered`. */
  answers: AnswerCoverage;
  latency: Map<string, ArmLatency>;
  listCost: Map<string, ListCost>;
  savings: Map<string, TokenSavings>;
  inventory: CatalogInventory;
  /**
   * Per arm, how much of the BASELINE's list that arm also returned. Absent for
   * the baseline itself, which would trivially reproduce its own list.
   */
  coverage: Map<string, CoverageScore>;
  /**
   * The headline: one score per arm built from the strongest evidence each
   * search has, carrying the evidence mix that produced it.
   */
  unified: Map<string, UnifiedScore>;
  /**
   * Per serving arm, how often a search led the agent to run anything.
   *
   * The scored population only holds searches the agent acted on, and whether
   * it acted depends on the served list. This is where those dropped failures
   * become visible.
   */
  followThrough: FollowThroughReport;
  diagnostics: QualitySelectionDiagnostics;
  /** Arms in a stable order: the baseline first, then the rest alphabetically. */
  arms: string[];
}

export type QualityServiceDb = ReturnType<typeof getDb>;

export interface LoadQualityViewOptions {
  pricePerMtok?: number;
  limit?: number;
}

/** Everything the admin quality page and the PDF report render from. */
export async function loadQualityView(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: QualityServiceDb = getDb(),
  options: LoadQualityViewOptions = {},
): Promise<QualityView | null> {
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      organizationName: organizations.name,
    })
    .from(projects)
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const [{ selections, diagnostics }, inventory] = await Promise.all([
    loadEvaluableSelections(projectId, experimentName, window, db, options.limit),
    loadCatalogInventory(projectId, db),
  ]);

  const baselineArm = pickBaselineArm(selections);
  const arms = orderArms(selections, baselineArm);
  const tiers = scoreTiers(selections, baselineArm, diagnostics.attributionMode);
  const latency = summarizeLatency(selections);
  const listCost = summarizeCost(selections);
  const coverage = summarizeCoverage(selections, baselineArm);
  const unified = new Map<string, UnifiedScore>();
  if (baselineArm !== null) {
    for (const [arm, observations] of observeUnified(selections, baselineArm)) {
      unified.set(arm, scoreUnified(observations));
    }
  }
  const savings = await summarizeSavings(
    projectId,
    inventory,
    selections,
    listCost,
    baselineArm,
    db,
    options.pricePerMtok,
  );

  return {
    projectId,
    projectName: project.name,
    projectSlug: project.slug,
    organizationName: project.organizationName,
    experimentName,
    window,
    tiers,
    answers: summarizeAnswers(selections),
    latency,
    listCost,
    savings,
    inventory,
    coverage,
    unified,
    followThrough: followThrough(selections),
    diagnostics,
    arms,
  };
}

/**
 * How much of the baseline's list each other arm also returned.
 *
 * Available on every comparison, because it needs only the two result lists and
 * no knowledge of what the agent did next. Where invocation telemetry is
 * missing, this is the densest honest signal there is.
 */
function summarizeCoverage(
  selections: readonly EvaluableSelection[],
  baselineArm: string | null,
): Map<string, CoverageScore> {
  const coverage = new Map<string, CoverageScore>();
  if (baselineArm === null) return coverage;

  const samples = new Map<string, CoverageSample[]>();
  for (const selection of selections) {
    const reference = selection.arms.find((arm) => arm.arm === baselineArm);
    if (!reference || reference.resultIds.length === 0) continue;
    for (const arm of selection.arms) {
      if (arm.arm === baselineArm) continue;
      const bucket = samples.get(arm.arm) ?? [];
      bucket.push({ reference: reference.resultIds, ours: arm.resultIds });
      samples.set(arm.arm, bucket);
    }
  }
  for (const [arm, bucket] of samples) {
    coverage.set(arm, scoreCoverage(bucket));
  }
  return coverage;
}

/** Score every arm under both tiers, keeping the populations separate. */
function scoreTiers(
  selections: readonly EvaluableSelection[],
  baselineArm: string | null,
  mode: AttributionMode,
): TierQuality[] {
  const tiers: TierQuality[] = [];
  for (const tier of ["revealed", "judged"] as const) {
    // Under `recorded-rank` only the serving arm can be scored per selection,
    // so the arms sit on different populations and the surfaces must say so
    // rather than inviting a head-to-head read of two unrelated denominators.
    // The answer key scores every arm over the same searches, so it always is.
    const comparable = tier === "judged" || mode === "tool-id";
    const note = tier === "revealed" ? ATTRIBUTION_NOTES[mode] : undefined;
    if (baselineArm === null) {
      tiers.push({ tier, baselineArm, arms: [], comparable, ...(note ? { note } : {}) });
      continue;
    }
    const grouped = byArm(observeSelections(selections, tier, baselineArm, mode));
    const baselineScore = comparable ? scoreObservations(grouped.get(baselineArm) ?? []) : null;

    const armScores: ArmQuality[] = [];
    for (const [arm, observations] of grouped) {
      const score = scoreObservations(observations);
      const bias = revealedArmBias(selections, arm);
      armScores.push({
        arm,
        role: roleOf(selections, arm),
        score,
        bias,
        biasNote: BIAS_NOTES[bias],
        separatedFromBaseline:
          arm !== baselineArm &&
          separated(score.containmentInterval, baselineScore?.containmentInterval ?? null),
      });
    }
    armScores.sort(
      (left, right) =>
        rankArm(left.arm, baselineArm) - rankArm(right.arm, baselineArm) ||
        compare(left.arm, right.arm),
    );
    tiers.push({
      tier,
      baselineArm,
      arms: armScores,
      comparable,
      ...(note ? { note } : {}),
    });
  }
  return tiers;
}

/**
 * Per-arm latency, taken from the arm's own recorded duration.
 *
 * The comparison record carries a duration for each side, which is the only
 * figure that isolates one arm: a span duration covers whatever else the trace
 * was doing, and a trace summary covers the whole request.
 */
function summarizeLatency(selections: readonly EvaluableSelection[]): Map<string, ArmLatency> {
  const durations = new Map<string, number[]>();
  const errors = new Map<string, { errored: number; total: number }>();

  for (const selection of selections) {
    for (const arm of selection.arms) {
      if (typeof arm.durationMs === "number" && Number.isFinite(arm.durationMs)) {
        const bucket = durations.get(arm.arm) ?? [];
        bucket.push(arm.durationMs);
        durations.set(arm.arm, bucket);
      }
      if (arm.outcome != null) {
        const counts = errors.get(arm.arm) ?? { errored: 0, total: 0 };
        counts.total += 1;
        if (arm.outcome === "error" || arm.outcome === "timeout") {
          counts.errored += 1;
        }
        errors.set(arm.arm, counts);
      }
    }
  }

  const latency = new Map<string, ArmLatency>();
  const names = new Set([...durations.keys(), ...errors.keys()]);
  for (const arm of names) {
    const samples = (durations.get(arm) ?? []).slice().sort((a, b) => a - b);
    const counts = errors.get(arm);
    latency.set(arm, {
      averageMs:
        samples.length === 0
          ? null
          : samples.reduce((total, value) => total + value, 0) / samples.length,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      errorRate: counts === undefined || counts.total === 0 ? null : counts.errored / counts.total,
      samples: samples.length,
    });
  }
  return latency;
}

/** Nearest-rank percentile over a pre-sorted array. */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function summarizeCost(selections: readonly EvaluableSelection[]): Map<string, ListCost> {
  const samples = new Map<string, ListCostSample[]>();
  for (const selection of selections) {
    for (const arm of selection.arms) {
      const bucket = samples.get(arm.arm) ?? [];
      bucket.push({
        returned: arm.resultIds.length,
        requested: arm.requestedK ?? null,
        scores: arm.resultScores ?? null,
      });
      samples.set(arm.arm, bucket);
    }
  }
  const cost = new Map<string, ListCost>();
  for (const [arm, bucket] of samples) {
    cost.set(arm, summarizeListCost(bucket));
  }
  return cost;
}

/**
 * What each arm's list would save against carrying the whole catalog.
 *
 * `realized` is true only for the arm that actually served: a shadow arm's
 * results were computed and thrown away, so nothing was saved yet. That
 * distinction is the difference between a claim a partner can check and one
 * they will catch us on.
 */
async function summarizeSavings(
  projectId: string,
  inventory: CatalogInventory,
  selections: readonly EvaluableSelection[],
  listCost: Map<string, ListCost>,
  baselineArm: string | null,
  db: Pick<QualityServiceDb, "select">,
  pricePerMtok?: number,
): Promise<Map<string, TokenSavings>> {
  const descriptions = await loadEntryDescriptions(
    projectId,
    inventory.entries.map((entry) => entry.entryId),
    db,
  );
  const fullCatalogTokens = catalogPromptTokens(inventory.entries, descriptions);

  const savings = new Map<string, TokenSavings>();
  for (const [arm, cost] of listCost) {
    if (arm === baselineArm) continue;
    savings.set(
      arm,
      estimateSavings({
        fullCatalogTokens,
        averageReturned: cost.averageReturned ?? 0,
        entryCount: inventory.entryCount,
        searchCount: cost.n,
        realized: roleOf(selections, arm) === "serving",
        pricePerMtok,
      }),
    );
  }
  return savings;
}

async function loadEntryDescriptions(
  projectId: string,
  entryIds: readonly string[],
  db: Pick<QualityServiceDb, "select">,
): Promise<Map<string, { description: string; inputSchema?: unknown }>> {
  const descriptions = new Map<string, { description: string; inputSchema?: unknown }>();
  if (entryIds.length === 0) return descriptions;

  const rows = await db
    .select({
      entryId: runtimeCatalogEntries.entryId,
      description: runtimeCatalogEntries.description,
      inputSchema: runtimeCatalogEntries.inputSchema,
    })
    .from(runtimeCatalogEntries)
    .where(
      and(
        eq(runtimeCatalogEntries.projectId, projectId),
        inArray(runtimeCatalogEntries.entryId, [...entryIds]),
      ),
    );

  for (const row of rows) {
    descriptions.set(row.entryId, {
      description: row.description,
      inputSchema: row.inputSchema,
    });
  }
  return descriptions;
}

/** Which role an arm mostly played across the window. */
function roleOf(
  selections: readonly EvaluableSelection[],
  arm: string,
): "serving" | "shadow" | "mixed" | null {
  let serving = 0;
  let shadow = 0;
  for (const selection of selections) {
    const ranking = selection.arms.find((candidate: ArmRanking) => candidate.arm === arm);
    if (!ranking) continue;
    if (ranking.role === "serving") serving += 1;
    else if (ranking.role === "shadow") shadow += 1;
  }
  if (serving > 0 && shadow > 0) return "mixed";
  if (serving > 0) return "serving";
  if (shadow > 0) return "shadow";
  return null;
}

function orderArms(
  selections: readonly EvaluableSelection[],
  baselineArm: string | null,
): string[] {
  const names = new Set<string>();
  for (const selection of selections) {
    for (const arm of selection.arms) names.add(arm.arm);
  }
  return [...names].sort(
    (left, right) =>
      rankArm(left, baselineArm) - rankArm(right, baselineArm) || compare(left, right),
  );
}

function rankArm(arm: string, baselineArm: string | null): number {
  return arm === baselineArm ? 0 : 1;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The admin index: every project with shadow comparisons, newest traffic first. */
export interface QualityProjectSummary {
  projectId: string;
  projectName: string;
  projectSlug: string;
  organizationName: string | null;
  calibrations: Array<{ experimentName: string; comparisonCount: number }>;
  comparisonCount: number;
  lastSeenAt: Date;
}

export async function listQualityProjectSummaries(
  window: ExperimentWindow,
  db: QualityServiceDb = getDb(),
): Promise<QualityProjectSummary[]> {
  const rows = await listQualityProjects(window, db);
  if (rows.length === 0) return [];

  const details = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      organizationName: organizations.name,
    })
    .from(projects)
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(
      inArray(
        projects.id,
        rows.map((row) => row.projectId),
      ),
    );
  const byId = new Map(details.map((detail) => [detail.id, detail]));

  const summaries = await Promise.all(
    rows.map(async (row) => {
      const detail = byId.get(row.projectId);
      return {
        projectId: row.projectId,
        projectName: detail?.name ?? "Unknown project",
        projectSlug: detail?.slug ?? row.projectId,
        organizationName: detail?.organizationName ?? null,
        calibrations: await listQualityCalibrations(row.projectId, window, db),
        comparisonCount: row.comparisonCount,
        lastSeenAt: row.lastSeenAt,
      };
    }),
  );
  return summaries;
}

/** How much faster an arm is than the baseline, for the headline tile. */
export function armSpeedup(
  latency: ReadonlyMap<string, ArmLatency>,
  baselineArm: string | null,
  arm: string,
): number | null {
  if (baselineArm === null) return null;
  return speedup(latency.get(baselineArm)?.p50Ms ?? null, latency.get(arm)?.p50Ms ?? null);
}
