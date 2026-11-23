import {
  FAILURE_FOLLOWED,
  type FailureFollowed,
  OUTCOME_CAUSES,
  type OutcomeCause,
  SESSION_OUTCOMES,
  type SessionOutcome,
  TURN_RESULTS,
  type TurnResult,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type { StoredQuestions } from "@/lib/readings/trace-signals/outcomes/model-read";
import type { QuestionsOff, StoredOutcomes } from "@/lib/readings/trace-signals/outcomes/run";

/**
 * A run's stored outcome counts (`trace_signal_runs.summary.outcomes`) read
 * back, and as the lines `make pipeline` prints. Counts and closed values
 * only.
 */

const CAUSE_WORDS: Record<OutcomeCause, string> = {
  bad_arguments: "bad arguments",
  wrong_reference: "wrong reference",
  tool_fault: "tool fault",
  not_allowed: "not allowed",
  other: "other",
};

const FOLLOWED_WORDS: Record<FailureFollowed, string> = {
  fixed_next_try: "fixed on the next try",
  fixed_after_detour: "fixed after a detour",
  switched_tool: "switched tool",
  nothing_followed: "nothing followed",
};

const RESULT_WORDS: Record<TurnResult, string> = {
  completed: "completed",
  completed_wrong: "completed wrong",
  failed: "failed",
  refused: "refused",
};

const OUTCOME_WORDS: Record<SessionOutcome, string> = {
  resolved_clean: "resolved cleanly",
  resolved_after_friction: "resolved after friction",
  gave_up: "gave up",
  blocked: "blocked",
  escalated: "escalated",
};

/** Why a reading asked no question, as a terminal says it. */
const OFF_WORDS: Record<QuestionsOff, string> = {
  no_key: "no model: no Sage key",
  cap_zero: "no model: the question cap is 0",
  switch_off: "no model: Sentiment analysis is off for this organization",
  failed: "no model: the questions failed",
};

const isQuestionsOff = (value: unknown): value is QuestionsOff =>
  typeof value === "string" && value in OFF_WORDS;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function countsOf<K extends string>(keys: readonly K[], value: unknown): Record<K, number> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(keys.map((key) => [key, count(record[key])])) as Record<K, number>;
}

/** The questions block a run stored; null when the questions were off. */
function storedQuestionsOf(value: unknown): StoredQuestions | null {
  if (!value || typeof value !== "object") return null;
  const q = value as Record<string, unknown>;
  return {
    version: count(q.version),
    turnsWithText: count(q.turnsWithText),
    turnsAnswered: count(q.turnsAnswered),
    fresh: count(q.fresh),
    cached: count(q.cached),
    capped: count(q.capped),
    failed: count(q.failed),
    calls: count(q.calls),
    inputTokens: count(q.inputTokens),
    stopped:
      q.stopped === "credentials" || q.stopped === "unavailable" || q.stopped === "invalid"
        ? q.stopped
        : null,
  };
}

const STOPPED_WORDS = {
  credentials: "the key was refused",
  unavailable: "Sage was unavailable or out of usage",
  invalid: "a request was refused",
} as const;

/** The outcome counts a run stored, or null when it stored none (an older run, or a reading that failed). */
export function storedOutcomesOf(summary: unknown): StoredOutcomes | null {
  const stored =
    summary && typeof summary === "object" ? (summary as { outcomes?: unknown }).outcomes : null;
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Record<string, unknown>;
  if (s.version !== 1) return null;
  const trust = s.trust && typeof s.trust === "object" ? (s.trust as Record<string, unknown>) : {};
  const questions = storedQuestionsOf(s.questions);
  const fusion =
    s.fusion && typeof s.fusion === "object" ? (s.fusion as Record<string, unknown>) : {};
  return {
    version: 1,
    ruleVersion: count(s.ruleVersion),
    trust: {
      runs: trust.runs === "all" || trust.runs === "exact" ? trust.runs : "none",
      sessions: trust.sessions === true,
    },
    turns: count(s.turns),
    sessions: count(s.sessions),
    failedCalls: count(s.failedCalls),
    errorsUnread: count(s.errorsUnread),
    causes: countsOf(OUTCOME_CAUSES, s.causes),
    otherShapes: count(s.otherShapes),
    streaks: count(s.streaks),
    followed: countsOf(FAILURE_FOLLOWED, s.followed),
    unmetSearches: count(s.unmetSearches),
    catalogListings: count(s.catalogListings),
    openRequests: count(s.openRequests),
    // A run from before the fusion stored none: it reads as zeros.
    fusion: {
      results: countsOf(TURN_RESULTS, fusion.results),
      falseCompletions: count(fusion.falseCompletions),
      sessions: countsOf(SESSION_OUTCOMES, fusion.sessions),
      ruleOnlySessions: count(fusion.ruleOnlySessions),
    },
    ...(questions ? { questions } : {}),
    ...(isQuestionsOff(s.questionsOff) ? { questionsOff: s.questionsOff } : {}),
  };
}

const n = (value: number): string => value.toLocaleString("en-US");

/** The counts as lines for a terminal. */
export function outcomeLines(stored: StoredOutcomes): string[] {
  const causes = OUTCOME_CAUSES.map(
    (cause) => `${CAUSE_WORDS[cause]} ${n(stored.causes[cause])}`,
  ).join(", ");
  const unknown =
    stored.causes.other > 0
      ? ` in ${n(stored.otherShapes)} unknown ${stored.otherShapes === 1 ? "shape" : "shapes"}`
      : "";
  const followed = FAILURE_FOLLOWED.map(
    (kind) => `${FOLLOWED_WORDS[kind]} ${n(stored.followed[kind])}`,
  ).join(", ");
  const q = stored.questions ?? null;
  const questions = q
    ? [
        `questions v${q.version}: ${n(q.turnsAnswered)} of ${n(q.turnsWithText)} turns with user text answered; ${n(q.fresh)} asked in ${n(q.calls)} calls (${n(q.inputTokens)} input tokens), ${n(q.cached)} from the cache, ${n(q.capped)} left for the next run, ${n(q.failed)} failed${q.stopped ? `; stopped: ${STOPPED_WORDS[q.stopped]}` : ""}`,
      ]
    : [];
  return [
    `outcomes: ${n(stored.turns)} turns and ${n(stored.sessions)} sessions read (rules v${stored.ruleVersion}, ${q ? "questions on" : stored.questionsOff ? OFF_WORDS[stored.questionsOff] : "no model"})`,
    `failed calls ${n(stored.failedCalls)} by cause: ${causes}${unknown}; ${n(stored.errorsUnread)} without a readable message`,
    `failure streaks ${n(stored.streaks)}: ${followed}`,
    `search runs with no call after ${n(stored.unmetSearches)}, catalog listings ${n(stored.catalogListings)}, sessions left with an open request ${n(stored.openRequests)}`,
    `turn results: ${TURN_RESULTS.map((result) => `${RESULT_WORDS[result]} ${n(stored.fusion.results[result])}`).join(", ")}; said done over an error ${n(stored.fusion.falseCompletions)}`,
    `session outcomes: ${SESSION_OUTCOMES.map((outcome) => `${OUTCOME_WORDS[outcome]} ${n(stored.fusion.sessions[outcome])}`).join(", ")} (${n(stored.fusion.ruleOnlySessions)} from the trace alone)`,
    ...questions,
  ];
}
