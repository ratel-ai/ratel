import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import type { ConfidenceInterval } from "@/lib/readings/stats";
import {
  bm25Order,
  bootstrapInterval,
  REPLAY_TOP_K,
  type ReplayCase,
} from "@/lib/synthesis/match-quality/replay";
import { hitCredit, type QualityScore, scoreObservations } from "@/lib/synthesis/quality/metrics";
import type { CraftedProposalBody } from "@/lib/synthesis/tool-crafter/types";

/**
 * What a proposal would do to retrieval, replayed over the project's stored
 * labelled searches with the same BM25 the match-quality backtest uses. The
 * crafted corpus removes the source tools (and anything hidden) and adds the
 * crafted ones; each case's target is mapped through the proposal:
 *
 * - merge and fold: every source target becomes the one crafted tool;
 * - rewrite: the target keeps its id (only its text changed);
 * - deprecate: the hidden tool's target becomes the sibling it names, when the
 *   migration notes name one, else the case is unaffected by construction.
 *
 * Only cases whose target is a source tool can change, so `affectedN` is
 * reported beside `n`: a tiny lift on a large n is not a story. This measures
 * retrieval and nothing else; whether the agent calls the merged tool
 * correctly is not something a replay can see.
 */

export const BACKTEST_SCORER = "bm25-craft-replay" as const;

export interface CraftBacktest {
  scorer: typeof BACKTEST_SCORER;
  n: number;
  /** Cases whose target the proposal touches. */
  affectedN: number;
  before: QualityScore;
  after: QualityScore;
  /** Mean hit-credit delta over the affected cases, with a bootstrap interval. */
  delta: { quality: number | null; interval: ConfidenceInterval | null };
  /** Source id to crafted id, for the cases that moved. */
  mapping: Record<string, string>;
  caveats: string[];
}

/** The corpus after the proposal: sources and hidden tools out, crafted tools in. */
export function craftedCorpus(
  corpus: readonly CorpusEntry[],
  proposal: CraftedProposalBody,
): CorpusEntry[] {
  const removed = new Set([...proposal.sourceToolIds, ...proposal.hidden]);
  // A rewrite keeps its tool; its crafted entry carries the same id.
  const kept = corpus.filter(
    (entry) =>
      !removed.has(entry.entryId) ||
      (proposal.kind === "rewrite_tool" && proposal.crafted.some((c) => c.name === entry.entryId)),
  );
  const replaced = new Set(proposal.crafted.map((c) => c.name));
  return [
    ...kept.filter((entry) => !replaced.has(entry.entryId)),
    ...proposal.crafted.map(
      (tool): CorpusEntry => ({
        entryId: tool.name,
        name: tool.name,
        searchable: tool.searchableDescription,
        description: tool.description,
        source: "crafted",
        matchesAgentDescription: tool.searchableDescription === tool.description,
        tags: [],
      }),
    ),
  ];
}

/** Where each source target goes in the crafted corpus; a source with no destination is unaffected. */
export function targetMapping(proposal: CraftedProposalBody): {
  mapping: Record<string, string>;
  caveats: string[];
} {
  const mapping: Record<string, string> = {};
  const caveats: string[] = [];
  if (proposal.kind === "rewrite_tool") {
    for (const tool of proposal.crafted) mapping[tool.name] = tool.name;
    return { mapping, caveats };
  }
  if (proposal.kind === "deprecate_tool") {
    const replacement =
      proposal.crafted[0]?.name ??
      proposal.migrationNotes.match(/use `?([a-zA-Z][a-zA-Z0-9_-]+)`? instead/)?.[1] ??
      null;
    for (const hidden of proposal.hidden) {
      if (replacement) mapping[hidden] = replacement;
      else
        caveats.push(
          `${hidden}: no replacement named, so its searches are scored as misses after retirement`,
        );
    }
    return { mapping, caveats };
  }
  const crafted = proposal.crafted[0];
  if (crafted) for (const source of proposal.sourceToolIds) mapping[source] = crafted.name;
  return { mapping, caveats };
}

function rankOf(ids: readonly string[], target: string): number | null {
  const index = ids.indexOf(target);
  return index === -1 ? null : index + 1;
}

export function backtestCraft(
  corpus: readonly CorpusEntry[],
  cases: readonly ReplayCase[],
  proposal: CraftedProposalBody,
): CraftBacktest {
  const { mapping, caveats } = targetMapping(proposal);
  const touched = new Set([...proposal.sourceToolIds, ...proposal.hidden]);
  const beforeOrder = bm25Order(corpus);
  const afterOrder = bm25Order(craftedCorpus(corpus, proposal));

  const before: { rank: number | null }[] = [];
  const after: { rank: number | null }[] = [];
  const deltas: number[] = [];
  let affectedN = 0;
  for (const c of cases) {
    const beforeRank = rankOf(beforeOrder(c.query, REPLAY_TOP_K), c.targetEntryId);
    let afterRank: number | null;
    if (!touched.has(c.targetEntryId))
      afterRank = rankOf(afterOrder(c.query, REPLAY_TOP_K), c.targetEntryId);
    else {
      affectedN += 1;
      const destination = mapping[c.targetEntryId];
      afterRank = destination ? rankOf(afterOrder(c.query, REPLAY_TOP_K), destination) : null;
      deltas.push(hitCredit(afterRank) - hitCredit(beforeRank));
    }
    before.push({ rank: beforeRank });
    after.push({ rank: afterRank });
  }
  const mean = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  return {
    scorer: BACKTEST_SCORER,
    n: cases.length,
    affectedN,
    before: scoreObservations(before),
    after: scoreObservations(after),
    delta: {
      quality: mean,
      interval:
        deltas.length > 0
          ? bootstrapInterval(deltas, `${proposal.kind}:${proposal.sourceToolIds.join("|")}`)
          : null,
    },
    mapping,
    caveats: [
      ...caveats,
      "Retrieval only: whether the agent fills the crafted schema correctly is not measured here.",
    ],
  };
}
