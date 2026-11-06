import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getRuntimeCatalogOverrideAdoption } from "@/lib/synthesis/catalog/runtime-reads";
import { buildReplayCases } from "@/lib/synthesis/match-quality/labels";
import { loadLabels, loadReplayHistory } from "@/lib/synthesis/match-quality/queries";
import { replay } from "@/lib/synthesis/match-quality/replay";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import { isSearchTelemetry } from "@/lib/synthesis/match-quality/search-source";
import { runStatus } from "@/lib/synthesis/match-quality/view";
import type { QualityContext } from "./context";
import {
  catalogEditHref,
  type Projection,
  projectionOf,
  type RewriteRow,
  type RunView,
  rewriteForTool,
  rewriteRows,
  runView,
  type ToolCard,
  toolCard,
} from "./descriptions";
import type { QualityEvidence } from "./load-misses";
import type { QualityRunState } from "./load-suggestions";

/**
 * Quality › Descriptions: the rewrites the analysis drafted (from the run
 * state the header already read), what applying every pending one does in a
 * replay of past searches, whether an applied rewrite reaches the agent, and
 * the tool `?tool=` asked for when it has no rewrite. Each extra read degrades
 * on its own; nothing here writes.
 */

export interface DescriptionsData {
  pending: RewriteRow[];
  applied: RewriteRow[];
  projection: Projection | null;
  run: RunView | null;
  /** True only when a runtime fetched the overrides recently; null is no evidence either way. */
  overridesAdopted: boolean | null;
  /** The experiment a rewrite's searches came from, so "Test this search" can carry ids; null for plain search telemetry. */
  experimentName: string | null;
  tool: ToolCard | null;
}

/** Null when the run state could not be read: the tab says so in place. */
export async function loadDescriptions({
  context,
  state,
  evidence,
  tool,
}: {
  context: QualityContext;
  state: QualityRunState;
  evidence: QualityEvidence | null;
  /** `?tool=`, when a link asked for one tool. */
  tool: string | null;
}): Promise<DescriptionsData | null> {
  if (state.failed) return null;
  const projectId = context.project.id;
  const rows = rewriteRows(state.proposals);
  const wantsCard =
    tool !== null && rewriteForTool([...rows.pending, ...rows.applied], tool) === null;
  const [projection, overridesAdopted, card] = await Promise.all([
    loadProjection(projectId, state.run, state.proposals),
    loadOrFallback<boolean | null>({
      operation: "quality_v2_descriptions_override_adoption",
      distinctId: `project:${projectId}`,
      fallback: null,
      load: () =>
        withStatementTimeout((db) => getRuntimeCatalogOverrideAdoption(projectId, db), {
          operation: "quality_v2_descriptions_override_adoption",
        }),
    }),
    wantsCard ? loadToolCard(projectId, tool, evidence) : Promise.resolve(null),
  ]);
  const experimentName =
    state.run && !isSearchTelemetry(state.run.experimentName) ? state.run.experimentName : null;
  return {
    ...rows,
    projection,
    run: runView(state.run),
    overridesAdopted,
    experimentName,
    tool: card,
  };
}

/**
 * Every pending rewrite replayed together over today's catalog (which already
 * carries the applied ones), against the answer key: the number that shrinks
 * as rewrites are applied one by one. Model-free; null when there is nothing
 * pending, nothing to replay, or the read fails.
 */
async function loadProjection(
  projectId: string,
  run: MatchQualityRunRow | null,
  proposals: readonly MatchQualityProposalRow[],
): Promise<Projection | null> {
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  if (!run?.tunedArm || runStatus(run).phase !== "analyzed" || pending.length === 0) return null;
  const tunedArm = run.tunedArm;
  return loadOrFallback<Projection | null>({
    operation: "quality_v2_descriptions_projection",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      // One after another: the three reads share the bounded transaction's connection.
      const { history, labels, corpus } = await withStatementTimeout(
        async (db) => ({
          history: await loadReplayHistory(projectId, undefined, db),
          labels: await loadLabels(projectId, db),
          corpus: await loadToolCorpus(projectId, db),
        }),
        { operation: "quality_v2_descriptions_replay_read" },
      );
      const cases = buildReplayCases(history, labels, tunedArm, run.baselineArm ?? "");
      if (cases.length === 0) return null;
      const result = replay(
        corpus,
        cases,
        pending.map((proposal) => ({
          entryId: proposal.entryId,
          searchableDescription: proposal.proposedSearchable,
        })),
      );
      return projectionOf(result, pending.length);
    },
  });
}

/** The tool a link asked for, as the catalog describes it now, with its searches in this window. */
async function loadToolCard(
  projectId: string,
  toolId: string,
  evidence: QualityEvidence | null,
): Promise<ToolCard | null> {
  return loadOrFallback<ToolCard | null>({
    operation: "quality_v2_descriptions_tool",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      const corpus = await withStatementTimeout((db) => loadToolCorpus(projectId, db), {
        operation: "quality_v2_descriptions_tool",
      });
      const entry = corpus.find((row) => row.entryId === toolId) ?? null;
      const tally = evidence?.tools[toolId];
      if (!entry) {
        return {
          id: toolId,
          name: toolId,
          description: null,
          source: null,
          tally: tally && tally.searches > 0 ? tally : null,
          catalogHref: catalogEditHref(projectId, toolId),
        };
      }
      return toolCard(entry, tally, catalogEditHref(projectId, entry.name));
    },
  });
}
