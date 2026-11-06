import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { getLatestRun, listProposals, listRuns } from "@/lib/synthesis/match-quality/queries";
import { PROPOSAL_STATUSES } from "@/lib/synthesis/match-quality/types";
import { backtestView, censusFacts } from "@/lib/synthesis/match-quality/view";

/**
 * The improvement half of the product: what Ratel proposes changing, and the
 * evidence each proposal stands on.
 */
export interface ImprovementOperationDeps {
  listMatchQualityRuns: typeof listRuns;
  getLatestMatchQualityRun: typeof getLatestRun;
  listMatchQualityProposals: typeof listProposals;
}

export const defaultImprovementDeps: ImprovementOperationDeps = {
  listMatchQualityRuns: listRuns,
  getLatestMatchQualityRun: getLatestRun,
  listMatchQualityProposals: listProposals,
};

export function improvementOperations(
  deps: ImprovementOperationDeps = defaultImprovementDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_match_quality_runs",
      domain: "improvement",
      title: "List match quality runs",
      description:
        "Past analyses of search quality, each with the evidence census that bounds how much its proposals are worth. Read the census before the proposals: a run over a window with no invoked-tool records measured agreement with the baseline, not accuracy.",
      keywords: ["match quality", "search quality", "retrieval", "runs", "analysis"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, limit: limitParam }),
      async execute(ctx, params) {
        const rows = await deps.listMatchQualityRuns(ctx.projectId, params.limit);
        return {
          data: {
            count: rows.length,
            runs: rows.map((run) => ({
              id: run.id,
              status: run.status,
              trigger: run.trigger,
              windowDays: run.windowDays,
              createdAt: run.createdAt.toISOString(),
              searchesScored: run.selectionsEvaluated,
              revealedN: run.revealedN,
              judgedN: run.judgedN,
              // Searches with no answer: left out of every number. `referenceN`
              // is the same count under its old name, kept for existing callers.
              unansweredN: run.referenceN,
              referenceN: run.referenceN,
              attributionMode: run.attributionMode,
              model: run.mocked ? "local stand-in (no model called)" : run.model,
              declinedReason: run.declinedReason,
            })),
          },
        };
      },
    }),
    defineOperation({
      id: "get_match_quality_run",
      domain: "improvement",
      title: "Get match quality run",
      description:
        "One match quality analysis in full: what the run could see, what it concluded, and the searchable-description rewrites it proposed. Omit runId for the most recent run. Apply a proposal with set_catalog_override.",
      keywords: [
        "match quality",
        "why did search miss",
        "searchable description",
        "rewrite",
        "proposals",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        runId: z.string().uuid().optional(),
        status: z.enum(PROPOSAL_STATUSES).optional(),
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const run = params.runId
          ? (await deps.listMatchQualityRuns(ctx.projectId, 100)).find(
              (row) => row.id === params.runId,
            )
          : await deps.getLatestMatchQualityRun(ctx.projectId);
        if (!run) throw notFound("match quality run");

        const backtest = backtestView(run.backtest);
        const proposals = await deps.listMatchQualityProposals(ctx.projectId, {
          runId: run.id,
          // Superseded rows are a previous run's answer to a question this run has
          // already re-answered; serving them invites an agent to apply stale text.
          statuses: params.status ? [params.status] : ["pending", "applied"],
        });

        return {
          data: {
            run: {
              id: run.id,
              status: run.status,
              trigger: run.trigger,
              windowDays: run.windowDays,
              createdAt: run.createdAt.toISOString(),
              model: run.mocked ? "local stand-in (no model called)" : run.model,
              diagnosis: run.diagnosis,
              declinedReason: run.declinedReason,
            },
            // The census travels as the sentences the console prints, not as raw
            // counts: the caveats are the point, and an agent handed bare numbers
            // will quote a containment figure without the bias note attached to it.
            evidence: censusFacts(run).map((fact) => ({
              label: fact.label,
              value: fact.value,
              ...(fact.warning ? { warning: fact.warning } : {}),
            })),
            // The replay, for the same reason the census travels as sentences: an
            // agent handed a bare "+9 points" will quote it as a production
            // forecast, which it is not. The caveat and the interval ride along
            // with the figure so that anything repeating one repeats all three.
            ...(backtest
              ? {
                  backtest: {
                    qualityNow: backtest.before,
                    qualityIfApplied: backtest.after,
                    change: backtest.delta,
                    range: backtest.range,
                    significant: backtest.significant,
                    summary: backtest.headline,
                    population: backtest.population,
                    baselineQuality: backtest.baseline,
                    caveat: backtest.caveat,
                    movements: backtest.movements.map((row) => ({
                      kind: row.key,
                      label: row.label,
                      searches: row.n,
                    })),
                  },
                }
              : {}),
            proposals: proposals.map((proposal) => ({
              id: proposal.id,
              entryId: proposal.entryId,
              entryName: proposal.entryName,
              status: proposal.status,
              currentSearchableDescription: tracker.text(proposal.currentSearchable, 1_000),
              proposedSearchableDescription: tracker.text(proposal.proposedSearchable, 1_000),
              rationale: tracker.text(proposal.rationale, 600),
            })),
          },
          truncated: tracker.value,
        };
      },
    }),
  ];
}
