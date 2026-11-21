import { ToolRegistry } from "@ratel-ai/sdk";
import {
  type CorpusEntry,
  type EvalItem,
  indexableText,
  type ProposalPreview,
  type SpotCheckHit,
} from "./types";

/**
 * The before/after preview attached to every proposal, and the error bar that
 * has to travel with it.
 *
 * Ranking goes through `@ratel-ai/sdk`'s own `ToolRegistry` (the native BM25 the
 * SDK retrieves with) rather than a reimplementation, for the same reason
 * `lib/playground/rank.ts` does: a second scorer would quietly disagree with
 * production and the whole surface exists to be trusted.
 *
 * But "the same BM25" is not "the same ranker". Production fuses BM25 with a
 * dense pass and then the client filters by scope and truncates, so a Cloud-side
 * BM25 replay reproduces the served top result only about half the time. That is
 * not a bug to fix here, it is the honest precision of a cheap check, and the
 * only dishonest thing would be to print a delta without it. So every preview
 * measures its OWN reproduction rate against what the arm actually served, and
 * reports `inconclusive` whenever the movement it found is no larger than the
 * rate at which it disagrees with production anyway.
 *
 * This is why the type is `ProposalScorer` rather than a function: Phase 2's
 * hybrid replay is a second implementation of exactly this contract, reporting
 * exactly this error bar, and the surface reads `scorer` to say which one ran.
 */

/** Pinned, not a knob. Matches `lib/playground/rank.ts`'s `SEARCH_ORIGIN`. */
const SEARCH_ORIGIN = "agent";

/**
 * How deep the spot-check looks.
 *
 * Wider than a served list on purpose: a rewrite that moves the target from
 * nowhere to rank 9 has done something real, and a top-5 window would score that
 * identically to no change at all.
 */
const SPOT_CHECK_TOP_K = 20;

export interface ProposalPatch {
  entryId: string;
  searchableDescription: string;
}

export interface ProposalScorer {
  readonly id: ProposalPreview["scorer"];
  /** The share of searches whose served top result this scorer reproduces. */
  readonly reproductionRate: number | null;
  readonly reproductionSample: number;
  previewFor(patch: ProposalPatch): ProposalPreview;
}

/** One entry as the SDK's registry wants it. */
function registerAll(entries: readonly CorpusEntry[], patch: ProposalPatch | null): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of entries) {
    const searchable =
      patch && patch.entryId === entry.entryId ? patch.searchableDescription : entry.searchable;
    // The native registry rejects an empty description outright, which would
    // throw out of the scorer and fail the whole run. A catalog entry synced
    // without a description is a real thing; BM25 could never return it anyway,
    // so leaving it out of the index changes no ranking and saves the run.
    if (indexableText(searchable).length === 0 || indexableText(entry.name).length === 0) continue;
    // `register` is declared async but indexes in-process; the Playground calls it
    // the same way. Awaiting per entry would serialize ~100 no-op microtasks.
    void registry.register({
      id: entry.entryId,
      name: entry.name,
      description: searchable,
      // Observed entries carry no synced schema; an open object keeps the shape
      // valid without asserting parameters we do not actually know.
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
  }
  return registry;
}

function rankIn(registry: ToolRegistry, query: string, targetId: string): number | null {
  const hits = registry.searchWithOrigin(query, SPOT_CHECK_TOP_K, SEARCH_ORIGIN);
  const index = hits.findIndex((hit) => hit.toolId === targetId);
  return index === -1 ? null : index + 1;
}

function topIn(registry: ToolRegistry, query: string): string | null {
  const hits = registry.searchWithOrigin(query, 1, SEARCH_ORIGIN);
  return hits[0]?.toolId ?? null;
}

/** Items this scorer can actually rank: a captured query and a known target. */
function rankableItems(items: readonly EvalItem[]): EvalItem[] {
  return items.filter((item) => (item.query ?? "").trim().length > 0);
}

/**
 * Build a scorer over one corpus and one run's frozen items.
 *
 * The unpatched registry and the reproduction rate are computed ONCE and shared
 * across every proposal, because they do not depend on the patch and rebuilding
 * them per proposal would make a twelve-proposal run do twelve identical scans.
 */
export function createBm25Spotchecker(
  corpus: readonly CorpusEntry[],
  items: readonly EvalItem[],
  ourArm: string,
): ProposalScorer {
  const rankable = rankableItems(items);
  const before = registerAll(corpus, null);

  // How often this scorer, on the UNCHANGED corpus, picks the same winner the
  // arm actually served. Only searches where that arm returned something can
  // answer, so the sample is reported beside the rate.
  let reproduced = 0;
  let reproductionSample = 0;
  for (const item of rankable) {
    const ours = item.arms.find((arm) => arm.arm === ourArm);
    const servedTop = ours?.resultIds[0];
    if (!servedTop) continue;
    reproductionSample += 1;
    if (topIn(before, item.query as string) === servedTop) reproduced += 1;
  }
  const reproductionRate = reproductionSample === 0 ? null : reproduced / reproductionSample;

  return {
    id: "bm25-spotcheck",
    reproductionRate,
    reproductionSample,
    previewFor(patch) {
      // Only the searches this entry was supposed to win. A rewrite is judged on
      // the job it was drafted for, not on incidental movement elsewhere.
      const mine = rankable.filter((item) => item.targetEntryId === patch.entryId);
      const after = registerAll(corpus, patch);

      const seen = new Set<string>();
      const hits: SpotCheckHit[] = [];
      for (const item of mine) {
        const query = item.query as string;
        if (seen.has(query)) continue;
        seen.add(query);
        hits.push({
          query,
          targetEntryId: patch.entryId,
          before: rankIn(before, query, patch.entryId),
          after: rankIn(after, query, patch.entryId),
        });
      }

      let improved = 0;
      let worsened = 0;
      let unchanged = 0;
      for (const hit of hits) {
        // Absent is worse than any rank, so it sorts below all of them.
        const was = hit.before ?? Number.POSITIVE_INFINITY;
        const now = hit.after ?? Number.POSITIVE_INFINITY;
        if (now < was) improved += 1;
        else if (now > was) worsened += 1;
        else unchanged += 1;
      }

      return {
        scorer: "bm25-spotcheck",
        hits,
        improved,
        worsened,
        unchanged,
        reproductionRate,
        reproductionSample,
        inconclusive: isInconclusive(hits.length, improved, worsened, reproductionRate),
      };
    },
  };
}

/**
 * Whether the movement found is smaller than the scorer's own disagreement with
 * production.
 *
 * `1 - reproductionRate` is how often this scorer picks a different winner than
 * the arm actually served, i.e. its error rate. A net improvement share at or
 * below that is indistinguishable from the scorer being wrong, so it is reported
 * as inconclusive rather than as a win. With no reproduction sample there is no
 * error bar at all, and an unbounded number is not a result.
 */
export function isInconclusive(
  sampled: number,
  improved: number,
  worsened: number,
  reproductionRate: number | null,
): boolean {
  if (sampled === 0) return true;
  if (reproductionRate === null) return true;
  const netShare = (improved - worsened) / sampled;
  if (netShare <= 0) return true;
  return netShare <= 1 - reproductionRate;
}
