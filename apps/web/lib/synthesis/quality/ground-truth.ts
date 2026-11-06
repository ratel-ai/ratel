import {
  hitCredit,
  type RankObservation,
  type UnifiedObservation,
} from "@/lib/synthesis/quality/metrics";

/**
 * Deciding what the "right tool" was.
 *
 * Two ways of naming a target, and nothing is ever assumed:
 *
 *   REVEALED   the tool the agent actually ran off the back of this search.
 *              Behaviour, not opinion.
 *   JUDGED     the project's answer key (`match_quality_labels`): a model read
 *              the request against what each tool IS and named the right one,
 *              or the agent ran a tool for the same request elsewhere. Chosen
 *              independently of every arm, so every arm, the baseline included,
 *              is scored against it fairly. A search the key has no answer for,
 *              or marks unclear, is left out of every number rather than guessed.
 *
 * REFERENCE (the baseline's own first result) is no longer a scoring tier on the
 * quality surfaces. It survives only for the adaptive-ranking boost view, which
 * compares turn by turn against the incumbent and says so.
 *
 * The bias in REVEALED has to be stated wherever the number is shown. The agent
 * could only invoke something the SERVING arm put in front of it, so:
 *
 *   - for a SHADOW arm the target is independent of what that arm returned, and
 *     the measurement is honest;
 *   - for the SERVING arm the target was drawn from its own list, so its
 *     containment is inflated toward 100% almost by construction.
 *
 * {@link revealedArmBias} makes that explicit per arm rather than leaving it in
 * a comment, because a serving arm's 95% next to a shadow arm's 82% is a trap
 * for anyone reading the two as comparable.
 */

/** How a target was chosen. Never mixed inside one population. */
export type EvidenceTier = "revealed" | "judged" | "reference";

/** The tiers the quality surfaces score and store. `reference` is not one of them. */
export const EVIDENCE_TIERS: readonly EvidenceTier[] = ["revealed", "judged"];

/** Human labels, used by both the console and the report. */
export const TIER_LABELS: Record<EvidenceTier, { title: string; short: string; blurb: string }> = {
  revealed: {
    title: "Revealed",
    short: "what the agent ran",
    blurb:
      "The target is the tool the agent actually invoked after this search. Behaviour rather than opinion, and the strongest evidence available without a judge.",
  },
  judged: {
    title: "Answer key",
    short: "the right tool, decided",
    blurb:
      "The target is the right tool for the request, decided once per distinct query by a model reading it against what each tool is (never against our own rewritten descriptions), or taken from what the agent ran for the same request. Independent of every arm, so the arms are compared fairly. Searches it could not decide are left out, never guessed.",
  },
  reference: {
    title: "Reference",
    short: "agreement with the baseline",
    blurb:
      "The target is the baseline arm's own first result. Available on every comparison, and only as good as the baseline itself, so read it as agreement rather than accuracy.",
  },
};

/**
 * How the revealed target was identified for a window.
 *
 * `tool-id` is the good case: telemetry names the tool the agent ran, so EVERY
 * arm can be scored against it over one shared population, and the arms are a
 * true head-to-head.
 *
 * `recorded-rank` is the case today's SDK actually gives us. The invocation
 * record carries the rank the invoked tool held in the EFFECTIVE arm's list and
 * nothing that identifies the tool itself, so only the arm that served can be
 * scored, and each arm is scored over the sessions it happened to serve. Those
 * are different populations, so the arms are NOT comparable to each other. The
 * number is still a real read of that arm's own quality, and every surface says
 * which mode produced it.
 */
export type AttributionMode = "tool-id" | "recorded-rank" | "none";

export const ATTRIBUTION_NOTES: Record<AttributionMode, string> = {
  "tool-id":
    "Telemetry names the tool the agent ran, so every arm is scored against the same target over the same searches. The arms are directly comparable.",
  "recorded-rank":
    "Telemetry records where the invoked tool sat in the serving arm's list, but not which tool it was. Each arm is therefore scored only over the sessions it served, so the figures are honest per arm but are NOT a head-to-head. Comparing arms needs the tool id on the invocation record.",
  none: "No invocation in this window carries either a tool id or a recorded rank, so there is no revealed evidence to score.",
};

/** The rank an invoked tool held in the arm that served it. */
export interface RecordedInvocationRank {
  arm: string;
  /** 1-based, or null when the serving arm did not return it at all. */
  rank: number | null;
}

/** One arm's ranked output for a single search. */
export interface ArmRanking {
  arm: string;
  /** `serving` when this arm's list was the one handed to the agent. */
  role: "serving" | "shadow" | null;
  resultIds: readonly string[];
  resultScores?: readonly number[] | null;
  /** The limit the request asked for, when recorded. */
  requestedK?: number | null;
  /** How long this arm took to answer, in milliseconds. */
  durationMs?: number | null;
  /** `ok` | `empty` | `error` | `timeout`, as the SDK reported it. */
  outcome?: string | null;
}

/** Everything known about one shadow-tested search. */
export interface EvaluableSelection {
  selectionId: string;
  occurredAt: Date;
  query: string | null;
  arms: readonly ArmRanking[];
  /** The tool the agent ran, when telemetry named one for this search. */
  invokedToolId: string | null;
  /**
   * Where the invoked tool sat in the serving arm's list, when telemetry
   * recorded a position but not an identity.
   */
  invokedRank: RecordedInvocationRank | null;
  /**
   * The answer key's tool for this request, when it has one. Optional so every
   * existing constructor keeps compiling; absent reads as "no answer".
   */
  judgedToolId?: string | null;
  /**
   * Where the key's answer came from. `invoked` means the agent ran it on some
   * sighting of this request, so it was picked from whatever list SERVED that
   * sighting; scoring the serving arm against it is the survivorship trap the
   * revealed tier already avoids, and both scorers skip it.
   */
  judgedFrom?: "judge" | "invoked";
  /** True when the answer key read this request and could not decide it. */
  unclear?: boolean;
}

/** Where an arm placed the target for one search. */
export interface ArmObservation extends RankObservation {
  arm: string;
  selectionId: string;
}

/**
 * The 1-based position of `targetId` in `resultIds`, or null when absent.
 *
 * Null is a scored outcome (zero credit), not a missing one. Returning null for
 * "the arm returned nothing at all" and for "the arm returned five wrong tools"
 * is deliberate: both mean the agent did not get what it needed.
 */
export function rankOf(resultIds: readonly string[], targetId: string): number | null {
  const index = resultIds.indexOf(targetId);
  return index === -1 ? null : index + 1;
}

/**
 * The baseline arm's first result, used as the reference target.
 *
 * Only the baseline's own list can supply it. Taking it from whichever arm
 * happens to be listed first would score an arm against itself and read 100%.
 */
export function referenceTarget(selection: EvaluableSelection, baselineArm: string): string | null {
  const baseline = selection.arms.find((arm) => arm.arm === baselineArm);
  if (!baseline || baseline.resultIds.length === 0) return null;
  return baseline.resultIds[0] ?? null;
}

/** The tool the agent ran, when one was attributed to this search. */
export function revealedTarget(selection: EvaluableSelection): string | null {
  return selection.invokedToolId;
}

/** The answer key's tool for this search, or null when it has none. */
export function judgedTarget(selection: EvaluableSelection): string | null {
  return selection.judgedToolId ?? null;
}

/**
 * True when this arm served the search and the key's answer is an observed
 * invocation: the agent could only have run something this arm showed it.
 */
function selfSelected(selection: EvaluableSelection, arm: ArmRanking): boolean {
  return selection.judgedFrom === "invoked" && arm.role === "serving";
}

/** The target for a tier, or null when this search is not evaluable under it. */
export function targetFor(
  selection: EvaluableSelection,
  tier: EvidenceTier,
  baselineArm: string,
): string | null {
  if (tier === "revealed") return revealedTarget(selection);
  if (tier === "judged") return judgedTarget(selection);
  return referenceTarget(selection, baselineArm);
}

/**
 * Score every arm of every selection under one tier.
 *
 * Selections with no target under this tier are dropped rather than counted as
 * misses: "the agent never ran anything" is not evidence that retrieval failed,
 * and folding it in would drag every arm down by however sparse the telemetry
 * happens to be. The count that survives is `n`, and it is shown everywhere.
 *
 * Under `reference` the baseline is skipped: an arm scored against its own first
 * result would report a perfect 100% and put a meaningless bar on the chart.
 * Under `judged` it is not: the answer was chosen independently of every arm,
 * so the incumbent is measured like anyone else, which is the point.
 */
export function observeSelections(
  selections: readonly EvaluableSelection[],
  tier: EvidenceTier,
  baselineArm: string,
  mode: AttributionMode = "tool-id",
): ArmObservation[] {
  const observations: ArmObservation[] = [];

  // The revealed tier under `recorded-rank` cannot rank an arm that did not
  // serve, because nothing says which tool to look for. One observation per
  // selection, for the arm that served it, taken from the recorded position.
  if (tier === "revealed" && mode === "recorded-rank") {
    for (const selection of selections) {
      const recorded = selection.invokedRank;
      if (recorded === null) continue;
      observations.push({
        arm: recorded.arm,
        selectionId: selection.selectionId,
        rank: recorded.rank,
      });
    }
    return observations;
  }
  if (tier === "revealed" && mode === "none") return observations;

  for (const selection of selections) {
    const target = targetFor(selection, tier, baselineArm);
    if (target === null) continue;
    // An answer the agent was seen running was picked from the serving arm's
    // list. Dropping only that arm would put the arms on different populations
    // and void the head-to-head, so the whole search leaves this tier; the
    // revealed tier and `observeUnified` already score it fairly.
    if (tier === "judged" && selection.arms.some((arm) => selfSelected(selection, arm))) continue;
    for (const arm of selection.arms) {
      if (tier === "reference" && arm.arm === baselineArm) continue;
      observations.push({
        arm: arm.arm,
        selectionId: selection.selectionId,
        rank: rankOf(arm.resultIds, target),
      });
    }
  }
  return observations;
}

/**
 * Score every arm of every selection on the best evidence THAT SEARCH has.
 *
 * The unit of choice is the search, not the window: a partner emits invocation
 * attribution for some call paths and not others, so insisting on one mode
 * either throws away the strong evidence or throws away most of the population.
 *
 * Per search and per arm: if the tool the agent ran is known, rank it in that
 * arm's list. Otherwise rank the answer key's tool. A search with neither is
 * left out: there is no fallback to "whatever the baseline returned first",
 * because that is an assumption, and it scored the incumbent as always right.
 *
 * `selfSelected` marks the case where the arm being scored is the one that
 * served the search the evidence came from. Its containment is then close to a
 * tautology, because the agent could only run something it was shown. Its
 * PLACEMENT still carries signal: how far down its own list the agent had to go
 * is a real fact about that arm's ordering.
 */
export function observeUnified(
  selections: readonly EvaluableSelection[],
  _baselineArm?: string,
): Map<string, UnifiedObservation[]> {
  const byArmName = new Map<string, UnifiedObservation[]>();
  const push = (arm: string, observation: UnifiedObservation) => {
    const bucket = byArmName.get(arm);
    if (bucket) bucket.push(observation);
    else byArmName.set(arm, [observation]);
  };

  for (const selection of selections) {
    const target = selection.invokedToolId;
    const judged = judgedTarget(selection);

    for (const arm of selection.arms) {
      // SURVIVORSHIP: an agent can only invoke a tool it was shown, so the tool
      // it ran is in the serving arm's list by construction. Scoring that arm
      // against it is not a measurement, it is a restatement of the setup, and
      // it hands whichever arm happens to be serving a guaranteed 100%.
      //
      // So revealed evidence is produced ONLY for an arm that did not serve
      // this search. That arm had no influence on what the agent chose, which
      // is exactly what makes the test fair to it. The serving arm falls back
      // to the answer key like any unattributed search.
      const servedThisSearch = arm.role === "serving";
      if (target !== null && !servedThisSearch) {
        const rank = rankOf(arm.resultIds, target);
        push(arm.arm, {
          evidence: "revealed",
          credit: hitCredit(rank),
          reach: rank === null ? 0 : 1,
          contained: rank !== null,
        });
        continue;
      }
      if (judged === null || selfSelected(selection, arm)) continue;
      const rank = rankOf(arm.resultIds, judged);
      push(arm.arm, {
        evidence: "judged",
        credit: hitCredit(rank),
        reach: rank === null ? 0 : 1,
        contained: rank !== null,
      });
    }
  }
  return byArmName;
}

/**
 * How often a search led to the agent running something, per serving arm.
 *
 * The counterpart to the survivorship fix, and the bias it closes is the one
 * that cannot be closed by choosing evidence carefully: we only score searches
 * the agent ACTED on, and whether it acted depends on how good the served list
 * was. A serving arm that returns junk gets its failures deleted from the
 * population rather than counted, because the agent gave up and no invocation
 * was recorded.
 *
 * Follow-through cannot be silently folded into a quality score, since plenty
 * of searches end without a tool call for reasons that have nothing to do with
 * retrieval. But shown beside it, a serving arm whose searches are abandoned far
 * more often than the other's is the clearest evidence available that its lists
 * are worse, and it is evidence the scored population has thrown away.
 */
export interface FollowThrough {
  arm: string;
  /** Searches this arm served, where an invocation could have been recorded. */
  served: number;
  /** Of those, how many the agent then ran a tool for. */
  followed: number;
  /** Null when nothing in the window is instrumented; see below. */
  rate: number | null;
}

export interface FollowThroughReport {
  arms: FollowThrough[];
  /**
   * False when NO search in the window carries an invocation of any kind.
   *
   * The difference matters more than it looks. With no instrumentation every
   * arm scores 0%, which reads as "every agent abandoned every search" when the
   * truth is "nobody is reporting". Publishing that as an abandonment rate would
   * be the most alarming and least true number on the page, so the report says
   * it is not measurable instead.
   */
  measurable: boolean;
}

export function followThrough(selections: readonly EvaluableSelection[]): FollowThroughReport {
  const counts = new Map<string, { served: number; followed: number }>();
  let anyInstrumented = false;

  for (const selection of selections) {
    const followed = selection.invokedToolId !== null || selection.invokedRank !== null;
    if (followed) anyInstrumented = true;
    const serving = selection.arms.find((arm) => arm.role === "serving");
    if (!serving) continue;
    const entry = counts.get(serving.arm) ?? { served: 0, followed: 0 };
    entry.served += 1;
    if (followed) entry.followed += 1;
    counts.set(serving.arm, entry);
  }

  const arms = [...counts.entries()]
    .map(([arm, entry]) => ({
      arm,
      served: entry.served,
      followed: entry.followed,
      rate: !anyInstrumented || entry.served === 0 ? null : entry.followed / entry.served,
    }))
    .sort((left, right) => compare(left.arm, right.arm));

  return { arms, measurable: anyInstrumented };
}

/**
 * How much of the window the answer key covers.
 *
 * Accuracy is only ever computed over `answered`, so these three numbers travel
 * with it: a figure over 40 answered searches out of 900 is a sample, and the
 * page says so rather than letting it pass for the whole window.
 */
export interface AnswerCoverage {
  searches: number;
  /** Carry a tool the agent ran, or an answer-key verdict. */
  answered: number;
  /** Read by the answer key and left undecided. */
  unclear: number;
  /** Not read yet: the next weekly pass picks some of these up. */
  unread: number;
}

export function summarizeAnswers(selections: readonly EvaluableSelection[]): AnswerCoverage {
  let answered = 0;
  let unclear = 0;
  for (const selection of selections) {
    if (selection.invokedToolId !== null || (selection.judgedToolId ?? null) !== null)
      answered += 1;
    else if (selection.unclear) unclear += 1;
  }
  return {
    searches: selections.length,
    answered,
    unclear,
    unread: selections.length - answered - unclear,
  };
}

/** One stored answer, as `applyAnswerKey` needs it. */
export interface AnswerRow {
  entryId: string;
  source: string;
}

/**
 * The selections with an answer key attached, by normalized query.
 *
 * Pure, so the database loader and a run that has just bought new verdicts
 * attach answers the same way. `keyOf` is the key's own normalizer.
 */
export function applyAnswerKey(
  selections: readonly EvaluableSelection[],
  key: ReadonlyMap<string, AnswerRow>,
  keyOf: (query: string | null) => string | null,
): EvaluableSelection[] {
  if (key.size === 0) return [...selections];
  return selections.map((selection) => {
    const normal = keyOf(selection.query);
    const row = normal === null ? undefined : key.get(normal);
    if (!row) return selection;
    if (row.source === "unclear" || row.entryId === "") {
      return { ...selection, judgedToolId: null, judgedFrom: undefined, unclear: true };
    }
    return {
      ...selection,
      judgedToolId: row.entryId,
      judgedFrom: row.source === "invoked" ? ("invoked" as const) : ("judge" as const),
      unclear: false,
    };
  });
}

/** Which attribution the loaded window supports, best first. */
export function resolveAttributionMode(counts: {
  toolIds: number;
  recordedRanks: number;
}): AttributionMode {
  if (counts.toolIds > 0) return "tool-id";
  if (counts.recordedRanks > 0) return "recorded-rank";
  return "none";
}

/** Group observations by arm, preserving first-seen order. */
export function byArm(observations: readonly ArmObservation[]): Map<string, ArmObservation[]> {
  const grouped = new Map<string, ArmObservation[]>();
  for (const observation of observations) {
    const bucket = grouped.get(observation.arm);
    if (bucket) bucket.push(observation);
    else grouped.set(observation.arm, [observation]);
  }
  return grouped;
}

/** Why an arm's revealed number can or cannot be read at face value. */
export type RevealedBias = "independent" | "self-selected" | "mixed";

/**
 * Whether the revealed target was independent of the arm being scored.
 *
 * `self-selected` means this arm served the list the agent chose from, so its
 * containment is close to a tautology. `mixed` means the arm served some of
 * these searches and shadowed others, so the number sits somewhere between.
 */
export function revealedArmBias(
  selections: readonly EvaluableSelection[],
  arm: string,
): RevealedBias {
  let serving = 0;
  let shadow = 0;
  for (const selection of selections) {
    if (selection.invokedToolId === null) continue;
    const ranking = selection.arms.find((candidate) => candidate.arm === arm);
    if (!ranking) continue;
    if (ranking.role === "serving") serving += 1;
    else if (ranking.role === "shadow") shadow += 1;
  }
  if (serving > 0 && shadow > 0) return "mixed";
  return serving > 0 ? "self-selected" : "independent";
}

export const BIAS_NOTES: Record<RevealedBias, string> = {
  independent:
    "This arm shadowed these searches, so the tool the agent ran was chosen from someone else's list. The number is an honest read.",
  "self-selected":
    "This arm served these searches, so the agent could only run what this arm returned. Read its containment as close to a tautology, and compare arms on placement instead.",
  mixed:
    "This arm served some of these searches and shadowed others, so its containment sits between an honest read and a tautology.",
};

/**
 * Names that mean "the thing that was already here".
 *
 * Matched as whole words, not substrings. A substring test on a one-letter hint
 * like "a" matches "ratel", which would nominate our own arm as the incumbent
 * and invert every label on the page.
 */
const BASELINE_NAMES = new Set([
  "a",
  "control",
  "baseline",
  "legacy",
  "incumbent",
  "existing",
  "current",
]);
const BASELINE_WORD = /[a-z]+/g;

function namedAsBaseline(arm: string): boolean {
  const words = arm.toLowerCase().match(BASELINE_WORD) ?? [];
  return words.some((word) => BASELINE_NAMES.has(word));
}

/**
 * Pick the baseline arm: the incumbent everything else is measured against.
 *
 * NAME first, serving role second. The obvious heuristic is "whichever arm
 * served is the incumbent", and it is wrong in exactly the case that matters:
 * in Acme's production experiment Ratel serves the developer units and their
 * legacy search runs in shadow behind it. Ranking by serving count there
 * nominates Ratel as the baseline, and the whole surface then measures the
 * partner against us and labels our arm "yours" in their own report.
 *
 * An arm called "legacy" is the incumbent no matter which side is serving, so
 * the name is the stronger signal. Serving count only breaks ties between arms
 * that say nothing about themselves.
 */
export function pickBaselineArm(selections: readonly EvaluableSelection[]): string | null {
  const servingCounts = new Map<string, number>();
  const names = new Set<string>();
  for (const selection of selections) {
    for (const arm of selection.arms) {
      names.add(arm.arm);
      if (arm.role === "serving") {
        servingCounts.set(arm.arm, (servingCounts.get(arm.arm) ?? 0) + 1);
      }
    }
  }
  if (names.size === 0) return null;
  const sorted = [...names].sort(compare);

  const named = sorted.filter(namedAsBaseline);
  if (named.length === 1) return named[0];
  // Two arms both claiming an incumbent name is a naming problem, not a
  // decision this function can make well; fall through to serving count over
  // just those two rather than picking alphabetically among everything.
  const candidates = named.length > 1 ? named : sorted;

  const ranked = candidates
    .map((arm): [string, number] => [arm, servingCounts.get(arm) ?? 0])
    .sort((left, right) => right[1] - left[1] || compare(left[0], right[0]));
  if (ranked.length > 0 && ranked[0][1] > 0) return ranked[0][0];

  return candidates[0] ?? null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
