import { getRuntimeCatalogOverrideAdoption } from "@/lib/synthesis/catalog/runtime-reads";
import { getLatestRun, listProposals } from "@/lib/synthesis/match-quality/queries";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import { isSearchTelemetry } from "@/lib/synthesis/match-quality/search-source";
import { proposalFailures } from "@/lib/synthesis/match-quality/view";
import { playgroundHref } from "@/lib/synthesis/playground/links";
import type { RewriteInput } from "@/lib/views/fixes/build";
import { fixSeams } from "@/lib/views/fixes/seams";
import { toSuggestionRows } from "./suggestions";

/**
 * Quality's rewrites as Fixes reads them. Loading this module fills the seam `loadFixes` reads,
 * so Fixes lists the pending and applied rewrites, the dismissals and the override adoption.
 */

/** Most of a rewrite's missed searches knew their right answer because the agent ran it, or a judge read them. */
export function howWeKnow(evidence: unknown): RewriteInput["howWeKnow"] {
  const sources = proposalFailures(evidence).map((failure) => failure.targetSource);
  if (sources.length === 0) return null;
  const seen = sources.filter((source) => source === "invoked").length;
  const judged = sources.filter((source) => source === "judge").length;
  if (seen === 0 && judged === 0) return null;
  return seen >= judged ? "seen" : "judged";
}

export function rewriteInputs(
  projectId: string,
  proposals: readonly MatchQualityProposalRow[],
  run: MatchQualityRunRow | null,
): RewriteInput[] {
  const telemetry = !run || isSearchTelemetry(run.experimentName);
  const rows = toSuggestionRows(proposals, (query, selectionId) =>
    playgroundHref(projectId, {
      query,
      selectionId: telemetry ? null : selectionId,
      experimentName: telemetry ? null : run.experimentName,
    }),
  );
  const how = new Map(proposals.map((proposal) => [proposal.id, howWeKnow(proposal.evidence)]));
  return [...rows.pending, ...rows.applied].map((row) => ({
    row,
    howWeKnow: how.get(row.id) ?? null,
  }));
}

fixSeams.loadRewrites = async (projectId, _organization, db) => {
  // In turn: both run in one transaction, on one client.
  const proposals = await listProposals(
    projectId,
    { statuses: ["pending", "applied", "dismissed"] },
    db,
  );
  const run = await getLatestRun(projectId, db);
  return {
    rewrites: rewriteInputs(projectId, proposals, run),
    dismissed: proposals
      .filter((proposal) => proposal.status === "dismissed")
      .map((proposal) => ({ toolId: proposal.entryId, at: proposal.updatedAt.toISOString() })),
    overridesAdopted: await getRuntimeCatalogOverrideAdoption(projectId, db),
  };
};
