import { createHash } from "node:crypto";
import { type Config, getConfig } from "@/config";
import {
  CLOSED_QUESTION_MAX_REQUEST_TOKENS,
  type ClosedQuestion,
  type ClosedQuestionClient,
  ClosedQuestionError,
  type ClosedQuestionFailureReason,
  type ClosedQuestionOption,
  type ClosedQuestionReasoning,
  type ClosedQuestionRequest,
  estimateQuestionTokens,
  packBatches,
} from "@/lib/contracts/closed-questions";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

/**
 * Closed questions put to Sage 2 for an outcome reading: capped per run,
 * cached by content, off without a key.
 *
 * - **Off unless a key is set.** With no client nothing is read or asked and
 *   the reading stays rule-only.
 * - **Nothing is asked twice.** An answer is kept under the hash of its
 *   content and the hash of its question (id, version, wording, answers), so
 *   the same question about the same text is free ever after: a second run of
 *   a window asks nothing. A null answer (the model abstained) is kept as
 *   `unknown` and not asked again either; raising a question's version asks
 *   it again.
 * - **A hard cap per run** on fresh questions and on the input tokens they
 *   are estimated to cost. Asks are taken in the order given, so the caller
 *   puts what matters most first; what is left over waits for the next run.
 * - **Reasoning is off** unless the setting is `auto`, and then only for the
 *   questions that say they may reason. A batch has one reasoning setting, so
 *   those go in their own calls.
 * - **Unavailable is not an error of ours.** A 402 (the period's usage is
 *   used up), a 503 or a refused key stops the asking for this run: what was
 *   answered so far is kept, the rest waits, and the reading goes on with the
 *   rules.
 *
 * PRIVACY: the cache holds hashes, a closed answer and a probability. No
 * content is stored or logged.
 */

const logger = getLogger("trace-signals/outcome-questions");

/** Fresh questions per run. Env `TRACE_OUTCOMES_MAX_ASKS`, default 400; 0 turns the questions off. */
export const OUTCOME_MAX_ASKS = getConfig().traceOutcomes.maxAsks;

/**
 * Estimated input tokens of a run's fresh questions. Env
 * `TRACE_OUTCOMES_MAX_ASK_TOKENS`, default 400,000: two cents a run at the
 * list price.
 */
export const OUTCOME_MAX_ASK_TOKENS = getConfig().traceOutcomes.maxAskTokens;

/** Env `TRACE_OUTCOMES_REASONING`: `auto` lets the questions that may reason do so; anything else is off. */
export function outcomeReasoning(
  config: Pick<Config, "traceOutcomes"> = getConfig(),
): ClosedQuestionReasoning {
  return config.traceOutcomes.reasoning;
}

/** One closed question: fixed wording, fixed answers and a version. */
export interface OutcomeQuestion {
  id: string;
  /** Raise it when the wording or the answers change: answers of another version are not reused. */
  version: number;
  kind: "yesno" | "choice";
  instructions: string;
  /** A choice question's answers. */
  options?: readonly ClosedQuestionOption[];
  /** Reasons when the reasoning setting is `auto`. */
  mayReason?: boolean;
}

/** One question about one content. `key` is the caller's name for the answer. */
export interface OutcomeAsk {
  key: string;
  question: OutcomeQuestion;
  content: string;
}

/** What an abstention reads as, in the cache and on a row. */
export const UNKNOWN_ANSWER = "unknown";

/** A cached or fresh answer. `answer` is `yes`/`no`, a choice's option, or {@link UNKNOWN_ANSWER}. */
export interface OutcomeVerdict {
  answer: string;
  /** Yes/no: P(yes). Choice: P(the chosen option). Null when the model gave none. */
  probability: number | null;
}

export interface VerdictKey {
  contentHash: string;
  questionHash: string;
}

export interface StoredVerdict extends VerdictKey, OutcomeVerdict {}

export interface AskDeps {
  /** Null when no key is set: the questions are off. */
  client: ClosedQuestionClient | null;
  loadVerdicts: (
    projectId: string,
    keys: readonly VerdictKey[],
  ) => Promise<readonly StoredVerdict[]>;
  saveVerdicts: (projectId: string, model: string, rows: readonly StoredVerdict[]) => Promise<void>;
  maxAsks: number;
  maxTokens: number;
  reasoning: ClosedQuestionReasoning;
  /** True once the run is out of time: no further call is made. */
  outOfTime?: () => boolean;
}

export interface AskResult {
  /** By ask key. An ask with no entry was not answered: capped, failed or off. */
  verdicts: Map<string, OutcomeVerdict>;
  /** Distinct questions answered from the cache. */
  cached: number;
  /** Distinct questions asked and answered in this run (an abstention is an answer). */
  fresh: number;
  /** HTTP calls made. */
  calls: number;
  /** Input tokens the fresh questions were billed, as Sage reported them. */
  inputTokens: number;
  /** Input tokens the questions taken under the cap were estimated at: what the token cap counts. */
  estimatedTokens: number;
  /** Distinct questions left for a later run by the cap or the clock. */
  capped: number;
  /** Distinct questions a call was made for and no answer came back. They were sent, so they count against the cap like `fresh`. */
  failed: number;
  /** Why the asking stopped early, when it did. */
  stopped: ClosedQuestionFailureReason | null;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The cache key of a content: its hash. */
export const contentHashOf = (content: string): string => sha(content);

/** The cache key of a question: everything that decides its answer besides the content. */
export function questionHashOf(question: OutcomeQuestion): string {
  const options = (question.options ?? []).map((option) => [
    option.option,
    option.description ?? "",
  ]);
  return sha(
    JSON.stringify([question.id, question.version, question.kind, question.instructions, options]),
  );
}

const wire = (question: OutcomeQuestion): ClosedQuestion =>
  question.kind === "choice"
    ? {
        kind: "choice",
        id: question.id,
        instructions: question.instructions,
        options: question.options ?? [],
      }
    : { kind: "yesno", id: question.id, instructions: question.instructions };

interface Slot extends VerdictKey {
  ask: OutcomeAsk;
  keys: string[];
}

const slotId = (key: VerdictKey): string => `${key.contentHash}:${key.questionHash}`;

const empty = (): AskResult => ({
  verdicts: new Map(),
  cached: 0,
  fresh: 0,
  calls: 0,
  inputTokens: 0,
  estimatedTokens: 0,
  capped: 0,
  failed: 0,
  stopped: null,
});

/**
 * Answer `asks` from the cache, then ask what is missing, at most
 * `deps.maxAsks` questions and `deps.maxTokens` estimated tokens, in the
 * order given. Never throws for the model's sake: a failed call is logged,
 * reported and counted, and the asks it did not answer have no verdict.
 */
export async function askQuestions(
  projectId: string,
  asks: readonly OutcomeAsk[],
  deps: AskDeps,
): Promise<AskResult> {
  const result = empty();
  const client = deps.client;
  if (!client || asks.length === 0) return result;

  // The same question about the same content is one slot, however many asks share it.
  const slots = new Map<string, Slot>();
  for (const ask of asks) {
    const key = {
      contentHash: contentHashOf(ask.content),
      questionHash: questionHashOf(ask.question),
    };
    const slot = slots.get(slotId(key));
    if (slot) slot.keys.push(ask.key);
    else slots.set(slotId(key), { ...key, ask, keys: [ask.key] });
  }
  const settle = (slot: Slot, verdict: OutcomeVerdict) => {
    for (const key of slot.keys) result.verdicts.set(key, verdict);
  };

  const stored = await deps.loadVerdicts(
    projectId,
    [...slots.values()].map(({ contentHash, questionHash }) => ({ contentHash, questionHash })),
  );
  const missing = new Map(slots);
  for (const row of stored) {
    const slot = missing.get(slotId(row));
    if (!slot) continue;
    settle(slot, { answer: row.answer, probability: row.probability });
    missing.delete(slotId(row));
    result.cached += 1;
  }

  // The cap: asks in the order given, until the next one would pass either limit.
  const taken: Slot[] = [];
  let tokens = 0;
  let oversized = 0;
  for (const slot of missing.values()) {
    const size = estimateQuestionTokens(slot.ask.content, wire(slot.ask.question));
    // A question that could never fit a request is left out, not sent to fail: the caller clips what it sends.
    if (size > CLOSED_QUESTION_MAX_REQUEST_TOKENS) {
      oversized += 1;
      continue;
    }
    if (taken.length >= deps.maxAsks || tokens + size > deps.maxTokens) break;
    taken.push(slot);
    tokens += size;
  }
  result.capped = missing.size - taken.length - oversized;
  result.estimatedTokens = tokens;
  if (taken.length === 0) return result;

  for (const reasoning of ["off", "auto"] as const) {
    const group = taken.filter(
      (slot) =>
        (deps.reasoning === "auto" && slot.ask.question.mayReason === true ? "auto" : "off") ===
        reasoning,
    );
    // One request per content: its questions travel together and read it once each.
    const byContent = new Map<string, Slot[]>();
    for (const slot of group)
      byContent.set(slot.contentHash, [...(byContent.get(slot.contentHash) ?? []), slot]);
    const requests = [...byContent.values()].map(
      (asked): ClosedQuestionRequest & { slots: Slot[] } => ({
        content: asked[0]!.ask.content,
        questions: asked.map((slot) => wire(slot.ask.question)),
        slots: asked,
      }),
    );
    for (const batch of packBatches(requests)) {
      const size = batch.reduce((total, request) => total + request.slots.length, 0);
      if (result.stopped !== null || deps.outOfTime?.()) {
        result.capped += size;
        continue;
      }
      result.calls += 1;
      try {
        const answered = await client.decideBatch(batch, reasoning);
        result.inputTokens += answered.inputTokens;
        const rows: StoredVerdict[] = [];
        batch.forEach((request, i) => {
          request.slots.forEach((slot, j) => {
            const answer = answered.answers[i]?.[j];
            if (!answer) {
              result.failed += 1;
              return;
            }
            const verdict = {
              answer: answer.answer ?? UNKNOWN_ANSWER,
              probability: answer.probability,
            };
            rows.push({
              contentHash: slot.contentHash,
              questionHash: slot.questionHash,
              ...verdict,
            });
            settle(slot, verdict);
          });
        });
        result.fresh += rows.length;
        // Kept batch by batch: an answer that was paid for survives a later failure.
        await deps.saveVerdicts(projectId, client.model, rows);
      } catch (err) {
        result.failed += size;
        const reason = err instanceof ClosedQuestionError ? err.reason : null;
        const status = err instanceof ClosedQuestionError ? err.status : null;
        if (reason === null) throw err;
        // Out of usage, busy or a refused key: the rest of the run would fail the same way.
        if (reason !== "invalid") result.stopped = reason;
        logger[reason === "unavailable" ? "warn" : "error"](
          { err, project_id: projectId, questions: size, reason, status },
          "outcome questions failed",
        );
        if (reason !== "unavailable")
          reportServerException(err, `project:${projectId}`, { operation: "outcome_questions" });
      }
    }
  }
  return result;
}
