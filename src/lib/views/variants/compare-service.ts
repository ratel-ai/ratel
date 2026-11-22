import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { variantExperimentsEnabled } from "@/lib/platform/variants-flag";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import {
  readExperimentSamples,
  readExperimentVariants,
  type VariantsDb,
  type VariantWindow,
} from "@/lib/views/variants/compare-store";
import { compareVariants, type VariantComparison } from "@/lib/views/variants/domain/compare";

/**
 * The variant comparison read model (RC-870): the one service the console page
 * and the MCP tools read. Callers check `FF_VARIANT_EXPERIMENTS` first
 * (`variantExperimentsEnabledForProject`); this reads and computes only.
 */

export interface VariantExperimentSummary {
  experiment: string;
  runs: number;
  lastSeenAt: string;
  variants: { name: string; runs: number }[];
}

export interface VariantExperimentList {
  experiments: VariantExperimentSummary[];
  truncated: boolean;
}

export interface VariantComparisonResult extends VariantComparison {
  window: { since: string; until: string };
  truncated: boolean;
}

export interface VariantCompareDeps {
  /** Runs a read under the console's statement timeout. */
  read: <T>(operation: string, read: (db: VariantsDb) => Promise<T>) => Promise<T>;
  /** Whether the task scorers may run for this project (`cloud-eval-gate`). Off, the pass rate is null. */
  scorersEnabled: (projectId: string) => Promise<boolean>;
}

const SCORER_ACTOR = "system:variant-compare";
/** The widest window any variant read covers; a wider one keeps its last 30 days. */
export const MAX_VARIANT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export const defaultVariantCompareDeps: VariantCompareDeps = {
  read: (operation, read) =>
    withStatementTimeout((db) => read(db as unknown as VariantsDb), { operation }),
  scorersEnabled: (projectId) => evalGateEnabledForActor(projectId, SCORER_ACTOR),
};

/** The project's experiments in the window, each with its variants and run counts, newest first. */
export async function listVariantExperiments(
  projectId: string,
  window: VariantWindow,
  deps: VariantCompareDeps = defaultVariantCompareDeps,
): Promise<VariantExperimentList> {
  const bounded = boundVariantWindow(window);
  const { rows, truncated } = await deps.read("variant_experiments_list", (db) =>
    readExperimentVariants(projectId, bounded, db),
  );
  const byExperiment = new Map<string, VariantExperimentSummary>();
  for (const row of rows) {
    const summary = byExperiment.get(row.experiment) ?? {
      experiment: row.experiment,
      runs: 0,
      lastSeenAt: row.lastSeenAt.toISOString(),
      variants: [],
    };
    summary.runs += row.runs;
    if (row.lastSeenAt.toISOString() > summary.lastSeenAt)
      summary.lastSeenAt = row.lastSeenAt.toISOString();
    summary.variants.push({ name: row.variant, runs: row.runs });
    byExperiment.set(row.experiment, summary);
  }
  const experiments = [...byExperiment.values()];
  for (const experiment of experiments)
    experiment.variants.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  experiments.sort(
    (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.experiment.localeCompare(b.experiment),
  );
  return { experiments, truncated };
}

/** One experiment's per-variant comparison; null when it has no tagged trace in the window. */
export async function getVariantComparison(
  projectId: string,
  experiment: string,
  window: VariantWindow,
  deps: VariantCompareDeps = defaultVariantCompareDeps,
): Promise<VariantComparisonResult | null> {
  const bounded = boundVariantWindow(window);
  const scorers = await deps.scorersEnabled(projectId);
  const { samples, truncated } = await deps.read("variant_experiment_compare", (db) =>
    readExperimentSamples(projectId, experiment, bounded, { scorers }, db),
  );
  if (samples.length === 0) return null;
  const range = { since: bounded.since.toISOString(), until: bounded.until.toISOString() };
  return {
    ...compareVariants(experiment, samples, `${projectId}:${experiment}`),
    window: range,
    truncated,
  };
}

/** The window cut to its last `MAX_VARIANT_WINDOW_DAYS` days. */
export function boundVariantWindow(window: VariantWindow): VariantWindow {
  const earliest = new Date(window.until.getTime() - MAX_VARIANT_WINDOW_DAYS * DAY_MS);
  return window.since < earliest ? { since: earliest, until: window.until } : window;
}

/**
 * `FF_VARIANT_EXPERIMENTS` for the project, from its organization. False when the project is
 * unknown. Owned (ADR-0030): the switch reads the organization's id, not upstream's ingest flag
 * organization.
 */
export async function variantExperimentsEnabledForProject(projectId: string): Promise<boolean> {
  const organization = await getOrganizationByProjectId(projectId);
  if (!organization) return false;
  return variantExperimentsEnabled(projectId, organization);
}
