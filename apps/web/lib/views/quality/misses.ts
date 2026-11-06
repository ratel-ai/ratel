import { queryKey } from "@/lib/synthesis/match-quality/labels";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";

/**
 * The Misses list: searches whose right tool is known (the agent was seen
 * running it, or the answer key judged it) and that our ranking did not put
 * first. Nothing is assumed, so a search with neither is left out.
 *
 * This list shows every such search with how we know. The headline share is
 * stricter and reads one tier only (see `headline.ts`): a tool the agent ran
 * from our own list is a row here, labelled "Seen it run", but never a number.
 */

export type Evidence = "seen" | "judged";

/** How we know, in the product's words (DESIGN.md, Glossary). */
export const EVIDENCE_LABEL: Record<Evidence, string> = {
  seen: "Seen it run",
  judged: "Judged",
};

export interface RankedList {
  arm: string;
  /** True when this list was the one handed to the agent. */
  served: boolean;
  resultIds: readonly string[];
}

export interface ScoredSearch {
  selectionId: string;
  occurredAt: Date;
  query: string | null;
  /** The right tool's entry id. */
  target: string;
  evidence: Evidence;
  /** Our ranking for this search. */
  ours: RankedList;
  /** The other variant's ranking, when an experiment ran one beside ours. */
  comparison: RankedList | null;
  /** 1-based position of the right tool in our list, or null when we did not return it. */
  rank: number | null;
}

/** The right tool for one search and how we know it, or null when nobody knows. */
export function rightAnswer(
  selection: EvaluableSelection,
): { target: string; evidence: Evidence } | null {
  if (selection.invokedToolId) return { target: selection.invokedToolId, evidence: "seen" };
  if (selection.unclear) return null;
  const judged = selection.judgedToolId ?? null;
  if (!judged) return null;
  return { target: judged, evidence: selection.judgedFrom === "invoked" ? "seen" : "judged" };
}

/** Every search with a known right tool, scored against our ranking. */
export function scoreSearches(
  selections: readonly EvaluableSelection[],
  ourArm: string,
): ScoredSearch[] {
  const scored: ScoredSearch[] = [];
  for (const selection of selections) {
    const answer = rightAnswer(selection);
    if (!answer) continue;
    const ours = selection.arms.find((arm) => arm.arm === ourArm);
    if (!ours) continue;
    const other = selection.arms.find((arm) => arm.arm !== ourArm) ?? null;
    const index = ours.resultIds.indexOf(answer.target);
    scored.push({
      selectionId: selection.selectionId,
      occurredAt: selection.occurredAt,
      query: selection.query,
      target: answer.target,
      evidence: answer.evidence,
      ours: { arm: ours.arm, served: ours.role === "serving", resultIds: ours.resultIds },
      comparison: other
        ? { arm: other.arm, served: other.role === "serving", resultIds: other.resultIds }
        : null,
      rank: index === -1 ? null : index + 1,
    });
  }
  return scored;
}

export function isMiss(search: Pick<ScoredSearch, "rank">): boolean {
  return search.rank !== 1;
}

/** One tool's searches in a window: where it was the right tool, and how often we had it first or at all. */
export interface ToolTally {
  searches: number;
  first: number;
  found: number;
}

/** Every right tool's tally, by tool id: what a tool's description is doing for it today. */
export function toolTallies(
  scored: readonly Pick<ScoredSearch, "target" | "rank">[],
): Record<string, ToolTally> {
  const tallies: Record<string, ToolTally> = {};
  for (const search of scored) {
    const tally = (tallies[search.target] ??= { searches: 0, first: 0, found: 0 });
    tally.searches += 1;
    if (search.rank === 1) tally.first += 1;
    if (search.rank !== null) tally.found += 1;
  }
  return tallies;
}

/**
 * Where the right tool landed, as a status (DESIGN.md, Color is meaning): first
 * is good, ranked lower is worth a look, not returned is a failure.
 */
export type Outcome = "first" | "lower" | "missing";

export function outcomeOf(rank: number | null): Outcome {
  return rank === null ? "missing" : rank === 1 ? "first" : "lower";
}

/** Searches inside one window. */
export function within<T extends Pick<ScoredSearch, "occurredAt">>(
  scored: readonly T[],
  window: { since: Date; until: Date },
): T[] {
  return scored.filter(
    (search) => search.occurredAt >= window.since && search.occurredAt < window.until,
  );
}

/* - The list ----------------------------------------------------------------- */

/**
 * One miss, however often it was asked: the same request with the same right
 * tool is one row with a count, so the list reads as "what to fix" rather
 * than as a log of every time it happened.
 */
export interface MissGroup {
  /** The latest sighting's selection id: the row's `?peek=` value. */
  id: string;
  /** Every sighting's selection id, so an older shared link still opens this row. */
  selectionIds: string[];
  query: string | null;
  target: string;
  /** The strongest evidence any sighting had: seeing it run beats a verdict. */
  evidence: Evidence;
  count: number;
  /** The most recent sighting, whose ranking the row and the panel show. */
  latest: ScoredSearch;
}

export function groupMisses(scored: readonly ScoredSearch[]): MissGroup[] {
  const groups = new Map<string, MissGroup>();
  for (const search of scored) {
    if (!isMiss(search)) continue;
    const key = `${queryKey(search.query) ?? `selection:${search.selectionId}`}\u0000${search.target}`;
    const group = groups.get(key);
    groups.set(key, group ? foldSighting(group, search) : firstSighting(search));
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.count - left.count ||
      right.latest.occurredAt.getTime() - left.latest.occurredAt.getTime() ||
      (left.query ?? "").localeCompare(right.query ?? ""),
  );
}

function firstSighting(search: ScoredSearch): MissGroup {
  return {
    id: search.selectionId,
    selectionIds: [search.selectionId],
    query: search.query,
    target: search.target,
    evidence: search.evidence,
    count: 1,
    latest: search,
  };
}

function foldSighting(group: MissGroup, search: ScoredSearch): MissGroup {
  const newer = search.occurredAt > group.latest.occurredAt;
  return {
    id: newer ? search.selectionId : group.id,
    selectionIds: [...group.selectionIds, search.selectionId],
    query: newer ? (search.query ?? group.query) : group.query,
    target: group.target,
    evidence: search.evidence === "seen" ? "seen" : group.evidence,
    count: group.count + 1,
    latest: newer ? search : group.latest,
  };
}

/** The row a `?peek=` value opens: its own id, or any sighting folded into it. */
export function findMissGroup<T extends Pick<MissGroup, "id" | "selectionIds">>(
  groups: readonly T[],
  peek: string | null,
): T | null {
  if (!peek) return null;
  return (
    groups.find((group) => group.id === peek) ??
    groups.find((group) => group.selectionIds.includes(peek)) ??
    null
  );
}

/** Where the right tool sat, in words: "Ranked 3rd", "Not returned". */
export function rankLabel(rank: number | null): string {
  if (rank === null) return "Not returned";
  if (rank === 1) return "Ranked first";
  return `Ranked ${ordinal(rank)}`;
}

export function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}

/** Case-insensitive match on the request and both tool names. */
export function matchesSearch(
  row: { query: string | null; rankedFirstName: string | null; expectedName: string },
  text: string,
): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  return [row.query, row.rankedFirstName, row.expectedName].some(
    (value) => value !== null && value.toLowerCase().includes(needle),
  );
}
