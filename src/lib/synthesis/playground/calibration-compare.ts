import type { CapabilityKind, RankedBuckets } from "./types";

/**
 * Holding a Playground run against the arms that actually ran for a recorded
 * selection.
 *
 * The comparison is FOUR steps of one story, read left to right, and each step
 * answers exactly one question:
 *
 *   Served → Shadow    did the two arms disagree?
 *   Shadow → Now       does my catalog still do that today?
 *   Now    → My edits  does my edit change it?
 *
 * So every column diffs against the column before it, rather than all of them
 * against one baseline. Four independent lists made the reader align ids across
 * columns by eye to find any of those three answers; a chain states each one in
 * place.
 *
 * Nothing is flattened across buckets. The arms recorded ONE list mixing skills
 * and tools, but ordering a skill against a tool by score is something the
 * engine deliberately never does (BM25 scores over the two text shapes are not
 * comparable), so an arm's list is SPLIT by kind and compared inside each
 * bucket. That is also what removes the per-row "S"/"T" marker: the bucket a
 * row is in already says which it is.
 */

export interface RecordedArm {
  arm: string;
  role: "served" | "shadow";
  resultIds: string[];
  /** Aligned with `resultIds`. Absent when the arm did not export scores. */
  resultScores?: number[] | null;
}

/** Where a column's rows came from. Drives its label and its emphasis. */
export type ColumnKey = "served" | "shadow" | "now" | "edited";

/** How a row moved against the column immediately to its left. */
export type RowChange = "same" | "up" | "down" | "new";

export interface ComparisonRow {
  id: string;
  rank: number;
  /** Null in the first column, which has nothing to its left. */
  change: RowChange | null;
  /** Places gained against the column to the left. Negative is a drop. */
  delta: number | null;
  score: number | null;
  /**
   * `score` as a share of the strongest in its OWN column, in [0, 1].
   *
   * Normalized per column because scores are not comparable across them: two
   * arms can be different engine configurations, and BM25 is corpus-relative
   * even within one. What survives normalization is the only thing worth
   * drawing anyway, which is how far ahead the leader was.
   */
  fill: number;
}

export interface ComparisonColumn {
  key: ColumnKey;
  /** The recorded arm's name. Absent for the two live columns. */
  arm?: string;
  rows: ComparisonRow[];
  /** Rows that changed against the column to the left. */
  changed: number;
  /** True when an identical shadow column was folded into this one. */
  mergedShadow?: boolean;
}

/** A capability id lookup over the whole catalog, not just this run's hits. */
export type KindById = ReadonlyMap<string, CapabilityKind>;

function movement(
  id: string,
  rank: number,
  previous: Map<string, number>,
): { change: RowChange; delta: number | null } {
  const was = previous.get(id);
  if (was === undefined) return { change: "new", delta: null };
  if (was === rank) return { change: "same", delta: 0 };
  return { change: rank < was ? "up" : "down", delta: was - rank };
}

interface Entry {
  id: string;
  score: number | null;
}

/** An arm's entries for one bucket, in recorded order, renumbered within it. */
function armEntries(
  arm: RecordedArm | undefined,
  kind: CapabilityKind,
  kindById: KindById,
): Entry[] {
  if (!arm) return [];
  const scores = arm.resultScores ?? [];
  return arm.resultIds
    .map((id, index) => ({ id, score: scores[index] ?? null }))
    .filter((entry) => kindById.get(entry.id) === kind);
}

/**
 * The columns for one bucket, left to right, each diffed against the previous.
 *
 * `edited` is omitted when nothing is edited: two identical columns side by
 * side read as a comparison and send the reader hunting for a difference that
 * is not there.
 */
export function comparisonColumns({
  arms,
  saved,
  edited,
  kind,
  kindById,
  collapseShadow = false,
}: {
  arms: readonly RecordedArm[];
  saved: RankedBuckets;
  edited: RankedBuckets | null;
  kind: CapabilityKind;
  kindById: KindById;
  /**
   * Drop the shadow column because the live run already reproduces it exactly.
   *
   * Two columns holding the same list in the same order is not a comparison,
   * it is the same answer printed twice, and it is the state a healthy project
   * is in almost all of the time. Decided by the CALLER, over the whole
   * recording rather than per bucket, so Skills and Tools cannot end up with
   * different numbers of columns on one screen.
   */
  collapseShadow?: boolean;
}): ComparisonColumn[] {
  const bucket = kind === "skill" ? "skills" : "tools";
  const served = arms.find((arm) => arm.role === "served");
  const shadow = arms.find((arm) => arm.role === "shadow");
  const liveEntries = (hits: RankedBuckets[typeof bucket]): Entry[] =>
    hits.map((hit) => ({ id: hit.id, score: hit.score }));

  const sources: {
    key: ColumnKey;
    arm?: string;
    entries: Entry[];
    mergedShadow?: boolean;
  }[] = [];
  if (served) {
    sources.push({
      key: "served",
      arm: served.arm,
      entries: armEntries(served, kind, kindById),
    });
  }
  if (shadow && !collapseShadow) {
    sources.push({
      key: "shadow",
      arm: shadow.arm,
      entries: armEntries(shadow, kind, kindById),
    });
  }
  sources.push({
    key: "now",
    entries: liveEntries(saved[bucket]),
    ...(shadow && collapseShadow ? { mergedShadow: true } : {}),
  });
  if (edited) {
    sources.push({ key: "edited", entries: liveEntries(edited[bucket]) });
  }

  let previous: Map<string, number> | null = null;
  return sources.map((source) => {
    const ranks = new Map(source.entries.map((entry, index) => [entry.id, index + 1]));
    const strongest = source.entries.reduce((max, entry) => Math.max(max, entry.score ?? 0), 0);
    const rows: ComparisonRow[] = source.entries.map((entry, index) => ({
      id: entry.id,
      rank: index + 1,
      ...(previous ? movement(entry.id, index + 1, previous) : { change: null, delta: null }),
      score: entry.score,
      fill:
        entry.score === null || strongest <= 0
          ? 0
          : Math.max(0, Math.min(1, entry.score / strongest)),
    }));
    previous = ranks;
    return {
      key: source.key,
      ...(source.arm ? { arm: source.arm } : {}),
      ...(source.mergedShadow ? { mergedShadow: true } : {}),
      rows,
      changed: rows.filter((row) => row.change !== null && row.change !== "same").length,
    };
  });
}

/**
 * Recorded ids that are not in the catalog any more, so no bucket can hold
 * them.
 *
 * Silently dropping these would make a recorded arm look shorter than it was,
 * and "this capability is gone" is one of the better explanations for a
 * mismatch you cannot otherwise reproduce.
 */
export function unresolvedIds(arms: readonly RecordedArm[], kindById: KindById): string[] {
  const seen = new Set<string>();
  for (const arm of arms) {
    for (const id of arm.resultIds) {
      if (!kindById.has(id)) seen.add(id);
    }
  }
  return [...seen];
}

/**
 * Whether the live run still does what the shadow arm recorded.
 *
 * This is the question the whole surface is built to answer, and the one that
 * makes the recording trustworthy: the shadow arm ran this engine over this
 * catalog, so a re-run today should land in the same place. When it does not,
 * the catalog changed underneath the recording, and that is the finding rather
 * than a defect in the comparison.
 *
 * Compared as SETS with an order check, over the ids the recording actually
 * returned. The live run has its own top-K, so counting a live result the arm
 * never had room to return as a difference would report drift that is an
 * artifact of the budget.
 */
export function reproducesShadow(
  arms: readonly RecordedArm[],
  saved: RankedBuckets,
): { recorded: number; matched: number; sameOrder: boolean } | null {
  const shadow = arms.find((arm) => arm.role === "shadow");
  if (!shadow || shadow.resultIds.length === 0) return null;

  const live = [...saved.skills, ...saved.tools];
  const liveIds = new Set(live.map((hit) => hit.id));
  const matched = shadow.resultIds.filter((id) => liveIds.has(id));

  // Order is judged only over what both sides have: a recorded id the live run
  // lost is already reported by `matched`, and letting it also break the order
  // check would say the same thing twice.
  const liveOrder = live.map((hit) => hit.id).filter((id) => matched.includes(id));

  return {
    recorded: shadow.resultIds.length,
    matched: matched.length,
    sameOrder:
      matched.length === shadow.resultIds.length &&
      JSON.stringify(matched) === JSON.stringify(liveOrder),
  };
}

/**
 * Whether a run's query is the one a recorded selection belongs to.
 *
 * The arms were ranked for ONE query. Holding a run of some other prompt
 * against them compares two different questions and quietly reads as a real
 * result, so the comparison is shown only while the queries match.
 */
export function sameQuery(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface Reproduction {
  recorded: number;
  matched: number;
  sameOrder: boolean;
}

/**
 * The reproduction verdict in three words, and whether it is good news.
 *
 * Three distinct outcomes that a single "matches / does not match" would
 * flatten: the recording still stands, the same capabilities come back in a
 * different order, or some of them do not come back at all. Only the last one
 * means the reader cannot trust an edit tested against this recording.
 */
export function reproductionVerdict(reproduction: Reproduction): {
  label: string;
  ok: boolean;
  detail: string;
} {
  if (reproduction.sameOrder) {
    return {
      label: "still matches",
      ok: true,
      detail:
        "Your catalog today returns exactly what was recorded, so an edit tested here can be trusted against it.",
    };
  }
  const missing = reproduction.recorded - reproduction.matched;
  if (missing > 0) {
    return {
      label: "your catalog changed since",
      ok: false,
      detail: `Your catalog no longer finds ${missing} of the ${reproduction.recorded} results recorded here, so part of this comparison cannot be reproduced.`,
    };
  }
  return {
    label: "ranked differently since",
    ok: false,
    detail:
      "Your catalog still finds everything that was recorded here, but puts it in a different order now.",
  };
}
