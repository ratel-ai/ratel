import { isRetrySearch, SAME_ASK_MIN_JACCARD, sameAsk, searchBefore } from "@/lib/ledger/same-ask";
import type { InvokeOutcome, StepDraft, TurnSource } from "@/lib/ledger/types";
import { envNumber } from "@/lib/platform/env-number";
import { jaccard, tokenize } from "@/lib/readings/text/cluster";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { normalizeAsk } from "@/lib/readings/trace-signals/workflows/decide";
import { isExactRun, type RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * Self-corrections: the moments an agent backtracks or retries, read from a
 * turn's text-free steps and from the same user's next turn in the session.
 * This is the one definition of a retry in the product: every surface that
 * says retried, switched, gave up, searched again or asked again should read
 * these functions. Pure: no clock, no I/O.
 *
 * Kinds, each one event attributed to the tool call before it:
 *
 * - `retry_after_error`: a call failed and the same tool (or skill) is called
 *   again later in the turn. One event per failed call, at that later call.
 * - `switch_after_error`: a call failed and the next call is a different
 *   tool. One failure can be both: switch away, then come back and retry.
 * - `gave_up_after_error`: the turn's last call failed and no call ran after
 *   it (a search after it is not a run). Pinned to the failed call.
 * - `searched_again`: a search repeats the ask of the search right before it
 *   (`isRetrySearch`, `same-ask.ts`). Attributed to the last call between the
 *   two searches, or to none.
 * - `asked_again`: the same user's next turn in the session asks the same
 *   thing (their own words when both turns carry them, else `sameAsk` on the
 *   two turns' first searches) within {@link ASKED_AGAIN_MAX_GAP_MS}, and only
 *   where the run-boundary rules trust sessions ({@link trustOf}). Pinned to
 *   this turn's last step and attributed to its last call: the answer the
 *   user asked again about.
 *
 * Every failed call lands in at least one error kind: it is the turn's last
 * call, or the next call is the same tool or a different one. An error event
 * is recovered when a later call in the turn succeeded. A call is an
 * invocation with a target (`nodeIdOf`: a tool's catalog id, a skill as
 * `skill:<id>`); an `unknown` outcome (no end seen) is neither a failure nor
 * a success.
 *
 * Read here ({@link detectAfterErrors}): `error_loop`'s `retries`,
 * `turnWaste().retries` and so the `retry` turn shape (`signals/turn-facts.ts`,
 * `signals/accumulators.ts`) count `retry_after_error`; the OpenTelemetry
 * shapes `otel_failed`, `otel_switched` and `otel_retry` are gave up, switch
 * and retry (the same tool twice with nothing failing is a chain). The
 * signal run records every kind (`run.ts`).
 *
 * Still their own definitions (owned by the Tasks reading):
 * - `workflows/health.ts` `retryRuns`: the same tool twice in a row, any
 *   outcome. Here `retry_after_error`, which needs a failure and also counts a
 *   retry after another call; its `failedRuns` (the last call failed) is
 *   `gave_up_after_error`.
 * - `tool-explorer/reliability.ts` `retriedErrors`: an error, then a later
 *   call of the same tool. The same count as `retry_after_error`. Its
 *   `recoveredRetries` asks only whether that one retry worked; here any
 *   later ok call in the turn is a recovery.
 * - `workflows/decide.ts` `isUnresolved`: no call, or any failed call. A
 *   failure the agent recovered from is not unresolved here; a run that ended
 *   on one is `gave_up_after_error`.
 * - `tool_switch` is `switch_after_error` plus "the next tool worked", which
 *   is the recovery here, and it also counts a switch away from an empty
 *   result, which is not an error.
 *
 * Shared as they are: `same-ask.ts` `isRetrySearch` and `turnDetour` are what
 * `searched_again` reads, so the detour tile and this agree by construction.
 * Not superseded: `repeat_invoke` (ok calls repeated, nothing failed) and
 * `abandoned_search` (searched, ran nothing) are not corrections, and
 * `identical_retry` (the same arguments sent again) refines
 * `retry_after_error` where arguments are captured.
 */

export const SELF_CORRECTION_KINDS = [
  "retry_after_error",
  "switch_after_error",
  "gave_up_after_error",
  "searched_again",
  "asked_again",
] as const;

export type SelfCorrectionKind = (typeof SELF_CORRECTION_KINDS)[number];

/** The kinds that follow a failed call. */
export const ERROR_KINDS: ReadonlySet<SelfCorrectionKind> = new Set<SelfCorrectionKind>([
  "retry_after_error",
  "switch_after_error",
  "gave_up_after_error",
]);

/**
 * How long after a turn ends the same user's next turn can still be asking
 * again. Env `TRACE_SIGNALS_ASKED_AGAIN_GAP_MS`, default 10 minutes (the
 * prerequisites window). On one customer's replay every same-ask pair of
 * consecutive turns was 2 to 5 minutes apart.
 */
export const ASKED_AGAIN_MAX_GAP_MS = envNumber("TRACE_SIGNALS_ASKED_AGAIN_GAP_MS", 10 * 60_000);

/**
 * Content-word Jaccard (`tokenize` in `lib/text/cluster.ts`) at or above which
 * two asks in the users' own words are the same. High on purpose: "find the
 * Q3 roadmap review" and "change the priority of the Q3 roadmap review" share
 * half their words and are two needs. Env `TRACE_SIGNALS_ASKED_AGAIN_TEXT_JACCARD`.
 */
export const ASKED_AGAIN_MIN_TEXT_JACCARD = envNumber(
  "TRACE_SIGNALS_ASKED_AGAIN_TEXT_JACCARD",
  0.8,
  (n) => n > 0 && n <= 1,
);

export interface SelfCorrection {
  kind: SelfCorrectionKind;
  /** 1-based ordinal, in this turn, of the step that shows it (see the kinds above). */
  ordinal: number;
  /** The call before it, as a node id; null when there is none. */
  tool: string | null;
  /** That call's ordinal and outcome; null with `tool`. */
  toolOrdinal: number | null;
  toolOutcome: InvokeOutcome | null;
  /** Error kinds: whether a later call in the turn succeeded. Null for the other kinds. */
  recovered: boolean | null;
}

/** A turn as self-corrections read it; a `SignalTurn` satisfies it. */
export interface SelfCorrectionTurn
  extends Pick<
    SignalTurn,
    "sessionId" | "endUserKey" | "turnSource" | "startedAt" | "endedAt" | "endedBy" | "steps"
  > {
  /** The user's own words for the turn, when the customer sends them (a turn scope's message, an OTLP prompt). */
  askText?: string | null;
}

export interface AskedAgainOptions {
  /** Whether the run-boundary rules trust sessions ({@link trustOf}): each user's turns are theirs, in order. */
  sessionsTrusted: boolean;
  maxGapMs?: number;
  /** The same-ask bar for searches (`SAME_ASK_MIN_JACCARD`). */
  threshold?: number;
  textThreshold?: number;
}

export interface TurnSelfCorrections {
  /** In step order. */
  events: SelfCorrection[];
  /** Whether the user asked again in their next turn; null when it cannot be told. */
  askedAgain: boolean | null;
}

interface Call {
  step: StepDraft;
  node: string;
}

function callsOf(steps: readonly StepDraft[]): Call[] {
  return steps.flatMap((step) => {
    const node = nodeIdOf(step);
    return node === null ? [] : [{ step, node }];
  });
}

function eventAt(
  kind: SelfCorrectionKind,
  ordinal: number,
  call: Call | undefined,
  recovered: boolean | null,
): SelfCorrection {
  return {
    kind,
    ordinal,
    tool: call?.node ?? null,
    toolOrdinal: call?.step.ordinal ?? null,
    toolOutcome: call?.step.outcome ?? null,
    recovered,
  };
}

const KIND_ORDER: ReadonlyMap<SelfCorrectionKind, number> = new Map(
  SELF_CORRECTION_KINDS.map((kind, i) => [kind, i]),
);

function inStepOrder(a: SelfCorrection, b: SelfCorrection): number {
  return (
    a.ordinal - b.ordinal ||
    (a.toolOrdinal ?? 0) - (b.toolOrdinal ?? 0) ||
    (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0)
  );
}

function errorEvents(calls: readonly Call[]): SelfCorrection[] {
  return calls.flatMap((call, i) => {
    if (call.step.outcome !== "error") return [];
    const later = calls.slice(i + 1);
    const next = later[0];
    if (!next) return [eventAt("gave_up_after_error", call.step.ordinal, call, false)];
    const recovered = later.some((c) => c.step.outcome === "ok");
    const again = later.find((c) => c.node === call.node);
    return [
      ...(next.node === call.node
        ? []
        : [eventAt("switch_after_error", next.step.ordinal, call, recovered)]),
      ...(again ? [eventAt("retry_after_error", again.step.ordinal, call, recovered)] : []),
    ];
  });
}

function searchEvents(
  steps: readonly StepDraft[],
  calls: readonly Call[],
  threshold: number,
): SelfCorrection[] {
  return steps.flatMap((step) => {
    if (step.kind !== "search" || !isRetrySearch(steps, step, threshold)) return [];
    const previous = searchBefore(steps, step);
    const from = previous?.ordinal ?? 0;
    const between = calls
      .filter((c) => c.step.ordinal > from && c.step.ordinal < step.ordinal)
      .at(-1);
    return [eventAt("searched_again", step.ordinal, between, null)];
  });
}

/**
 * The error kinds of one turn (retries, switches and give-ups after a failed
 * call), in step order: what every per-turn shape and waste count reads. No
 * search comparisons, so it is cheap enough to call per turn per reading.
 */
export function detectAfterErrors(steps: readonly StepDraft[]): SelfCorrection[] {
  return errorEvents(callsOf(steps)).sort(inStepOrder);
}

/** Error self-corrections of one turn by kind, from {@link detectAfterErrors}. */
export function afterErrorKinds(steps: readonly StepDraft[]): ReadonlySet<SelfCorrectionKind> {
  return new Set(detectAfterErrors(steps).map((event) => event.kind));
}

/** The self-corrections inside one turn, from its steps in ordinal order: every kind but `asked_again`. */
export function detectInTurn(
  steps: readonly StepDraft[],
  threshold: number = SAME_ASK_MIN_JACCARD,
): SelfCorrection[] {
  const calls = callsOf(steps);
  return [...errorEvents(calls), ...searchEvents(steps, calls, threshold)].sort(inStepOrder);
}

/**
 * Whether two asks in the users' own words are the same: equal once case and
 * spacing are normalized, or sharing at least `threshold` of their content
 * words. Null when either is empty.
 */
export function sameAskText(
  a: string | null | undefined,
  b: string | null | undefined,
  threshold: number = ASKED_AGAIN_MIN_TEXT_JACCARD,
): boolean | null {
  const left = normalizeAsk(a ?? "");
  const right = normalizeAsk(b ?? "");
  if (left === "" || right === "") return null;
  if (left === right) return true;
  return jaccard(new Set(tokenize(left)), new Set(tokenize(right))) >= threshold;
}

/** Two searches can be compared when both carry a query hash, or both list hits. */
function comparable(a: StepDraft, b: StepDraft): boolean {
  const hashed = a.queryHash !== null && b.queryHash !== null;
  const listed = (a.hitIds?.length ?? 0) > 0 && (b.hitIds?.length ?? 0) > 0;
  return hashed || listed;
}

const firstSearch = (steps: readonly StepDraft[]): StepDraft | undefined =>
  steps.find((step) => step.kind === "search");

/** Whether two turns ask the same thing; null when they carry nothing to compare. */
function sameTurnAsk(
  turn: SelfCorrectionTurn,
  next: SelfCorrectionTurn,
  threshold: number,
  textThreshold: number,
): boolean | null {
  const byText = sameAskText(turn.askText, next.askText, textThreshold);
  if (byText !== null) return byText;
  const a = firstSearch(turn.steps);
  const b = firstSearch(next.steps);
  if (!a || !b || !comparable(a, b)) return null;
  return sameAsk(a, b, threshold);
}

const sameUser = (a: SelfCorrectionTurn, b: SelfCorrectionTurn): boolean =>
  a.sessionId === b.sessionId && (a.endUserKey ?? null) === (b.endUserKey ?? null);

/**
 * Whether the user asked again in `next`, the same user's next turn in the
 * session: true or false, or null when it cannot be told (sessions not
 * trusted, a run cut at a cap that `next` only continues, a `next` that
 * overlaps this turn, or a quick `next` with nothing to compare). No next
 * turn, one past the gap, or one of another session or end user: false.
 */
export function askedAgain(
  turn: SelfCorrectionTurn,
  next: SelfCorrectionTurn | null | undefined,
  options: AskedAgainOptions,
): boolean | null {
  if (!options.sessionsTrusted || turn.endedBy === "cap") return null;
  if (!next || !sameUser(turn, next)) return false;
  const gapMs = next.startedAt.getTime() - turn.endedAt.getTime();
  if (gapMs < 0) return null;
  if (gapMs > (options.maxGapMs ?? ASKED_AGAIN_MAX_GAP_MS)) return false;
  return sameTurnAsk(
    turn,
    next,
    options.threshold ?? SAME_ASK_MIN_JACCARD,
    options.textThreshold ?? ASKED_AGAIN_MIN_TEXT_JACCARD,
  );
}

/** The `asked_again` event of a turn the user asked again about: pinned to its last step, attributed to its last call. */
function askedAgainEvent(steps: readonly StepDraft[]): SelfCorrection | null {
  const last = steps.at(-1);
  return last ? eventAt("asked_again", last.ordinal, callsOf(steps).at(-1), null) : null;
}

/** One turn's self-corrections, `asked_again` included when its next turn asked the same thing. */
export function detectSelfCorrections(
  turn: SelfCorrectionTurn,
  next: SelfCorrectionTurn | null | undefined,
  options: AskedAgainOptions,
): TurnSelfCorrections {
  const events = detectInTurn(turn.steps, options.threshold);
  const asked = askedAgain(turn, next, options);
  const event = asked === true ? askedAgainEvent(turn.steps) : null;
  if (!event) return { events, askedAgain: asked };
  return { events: [...events, event].sort(inStepOrder), askedAgain: true };
}

/**
 * The only steps whether a user asked again reads: the turn's first search
 * (what it asked), its last call and its last step (where the event is
 * pinned), in step order. A run that pairs turns across pages keeps these
 * instead of every step; {@link readAskedAgain} answers the same on them.
 */
export function askedAgainSteps(steps: readonly StepDraft[]): StepDraft[] {
  const kept = [firstSearch(steps), callsOf(steps).at(-1)?.step, steps.at(-1)].filter(
    (step): step is StepDraft => !!step,
  );
  return [...new Set(kept)].sort((a, b) => a.ordinal - b.ordinal);
}

/** Whether the user asked again after a turn, and the event it makes when they did. */
export interface AskedAgainReading {
  askedAgain: boolean | null;
  event: SelfCorrection | null;
}

/**
 * The `asked_again` half of {@link readTurns}, parallel to `turns`: null for a
 * run the trust leaves out, and "cannot tell" when the same user's next turn
 * is one it leaves out. Reads only {@link askedAgainSteps} of each turn.
 */
export function readAskedAgain<T extends SelfCorrectionTurn>(
  turns: readonly T[],
  trust: SelfCorrectionTrust,
  options: Omit<AskedAgainOptions, "sessionsTrusted"> = {},
): (AskedAgainReading | null)[] {
  const nexts = nextInSession(turns);
  return turns.map((turn, index) => {
    if (!readsTurn(trust, turn.turnSource)) return null;
    const next = nexts[index];
    if (next && !readsTurn(trust, next.turnSource)) return { askedAgain: null, event: null };
    const asked = askedAgain(turn, next, { ...options, sessionsTrusted: trust.sessions });
    return { askedAgain: asked, event: asked === true ? askedAgainEvent(turn.steps) : null };
  });
}

type Sessioned = Pick<SelfCorrectionTurn, "sessionId" | "endUserKey" | "startedAt">;

const sessionKey = (turn: Sessioned): string => `${turn.sessionId}\u0001${turn.endUserKey ?? ""}`;

/**
 * Each turn's next turn of the same session and end user, by start time (ties
 * in input order), or null; parallel to `turns`. Several users can share one
 * session, so a user's next turn skips the turns of others in between, as the
 * prerequisites read does. Only the turns given are paired.
 */
export function nextInSession<T extends Sessioned>(turns: readonly T[]): (T | null)[] {
  const order = turns
    .map((turn, index) => ({ turn, index, key: sessionKey(turn) }))
    .sort((a, b) =>
      a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : a.turn.startedAt.getTime() - b.turn.startedAt.getTime() || a.index - b.index,
    );
  const position = new Map(order.map((entry, at) => [entry.index, at]));
  return turns.map((_, index) => {
    const at = position.get(index) ?? -1;
    const self = order[at];
    const following = order[at + 1];
    return self && following && following.key === self.key ? following.turn : null;
  });
}

/** What the run-boundary rules (`run-basis.ts`) let a reading trust. */
export interface SelfCorrectionTrust {
  /** Which runs are read: all, exact ones only, or none when runs hold several users' calls mixed together. */
  runs: "all" | "exact" | "none";
  /** Whether a user's turns in a session are theirs and in order, so `asked_again` can be read. */
  sessions: boolean;
}

/**
 * Trust from the window's run basis. Mixed runs (`blocked: mixed_runs`) make
 * every per-run reading meaningless, as for the run-bound signal kinds
 * (`run-bound.ts`). An `exact` basis reads exact runs only, as the signal run
 * does. Sessions are trusted unless guessed runs look mixed: a busy server
 * shares one session across users, even where some runs carry turn ids.
 */
export function trustOf(basis: Pick<RunBasis, "basis" | "blocked" | "mixed">): SelfCorrectionTrust {
  if (basis.blocked === "mixed_runs") return { runs: "none", sessions: false };
  return { runs: basis.basis === "exact" ? "exact" : "all", sessions: !basis.mixed };
}

/** Whether a run is read under this trust. */
export function readsTurn(trust: SelfCorrectionTrust, turnSource: TurnSource): boolean {
  if (trust.runs === "none") return false;
  return trust.runs === "all" || isExactRun(turnSource);
}

/**
 * Every turn's reading, parallel to `turns`: null for a run the trust leaves
 * out. Each turn is paired with the same user's next turn among those given;
 * when that next turn is left out, whether they asked again cannot be told.
 */
export function readTurns<T extends SelfCorrectionTurn>(
  turns: readonly T[],
  trust: SelfCorrectionTrust,
  options: Omit<AskedAgainOptions, "sessionsTrusted"> = {},
): (TurnSelfCorrections | null)[] {
  const asked = readAskedAgain(turns, trust, options);
  return turns.map((turn, index) => {
    const reading = asked[index];
    if (!reading) return null;
    const events = detectInTurn(turn.steps, options.threshold);
    return {
      events: reading.event ? [...events, reading.event].sort(inStepOrder) : events,
      askedAgain: reading.askedAgain,
    };
  });
}
