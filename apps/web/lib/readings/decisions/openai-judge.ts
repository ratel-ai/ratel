import { getLogger } from "@/lib/platform/logger";
import {
  bm25Order,
  type CorpusEntry,
  identityCriteria,
  JUDGE_MAX_DURATION_MS,
  JUDGE_MAX_OPTIONS,
  type JudgeCase,
  type JudgeEngine,
  type JudgeFraming,
  type JudgeVerdict,
  judgeOptions,
  TOOL_SEARCH_ABOUT,
  TOOL_SEARCH_QUESTION,
  verdictFrom,
} from "./judge";
import {
  buildDecisionRequest,
  DecisionCallError,
  type DecisionFraming,
  type DecisionOption,
  decisionClient,
  OPENAI_DECISIONS_MODEL,
  OPENAI_USD_PER_INPUT_TOKEN,
} from "./openai";

/**
 * The judge, as an OpenAI Decisions `choice` question per ask.
 *
 * It reads tool IDENTITY (never an operator's overrides, see `identityCriteria`), asks
 * the tuned "which tool next" question unless the caller frames another, narrows an
 * oversize catalog the same way every engine does, and abstains below 0.8. How the
 * question is asked is in `openai.ts`.
 *
 * A refusal (the whole rewording chain declined) is an abstention: the ask is stored
 * unclear, exactly like a low-confidence answer.
 *
 * Owned (ADR-0030): the one judge engine of this edition.
 */

const logger = getLogger("decisions/openai-judge");

export const OPENAI_MIN_CONFIDENCE = 0.8;

/** About $2 at $0.10 per million, or ~2,000 asks over a 100-tool catalog. */
export const OPENAI_MAX_INPUT_TOKENS_PER_RUN = 20_000_000;

/** In flight at once. Each ask is up to two sequential calls of ~300 ms. */
export const OPENAI_CONCURRENCY = 6;

/** Consecutive failed asks before the run is treated as misconfigured. */
export const OPENAI_MAX_CONSECUTIVE_FAILURES = 20;

export interface OpenAIJudgeConfig {
  apiKey: string;
  /** Another question than the tuned tool-search one. Absent keeps the tuned framing. */
  framing?: JudgeFraming;
  baseUrl?: string;
  model?: string;
  minConfidence?: number;
  maxInputTokens?: number;
  maxDurationMs?: number;
  concurrency?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Raised on a rejected key. Fatal to the whole run. */
export class OpenAIJudgeAuthError extends Error {}

/** Raised when nothing usable comes back, repeatedly. */
export class OpenAIJudgeUnavailableError extends Error {}

export function decisionOption(entry: CorpusEntry): DecisionOption {
  const text = identityCriteria(entry);
  return { id: entry.entryId, does: text.does, searchable: text.searchable };
}

export function judgeFraming(framing?: JudgeFraming): DecisionFraming {
  return {
    about: framing?.about ?? TOOL_SEARCH_ABOUT,
    question: framing?.question ?? TOOL_SEARCH_QUESTION.question,
  };
}

export function openaiJudgeEngine(config: OpenAIJudgeConfig): JudgeEngine {
  const client = decisionClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fetchImpl: config.fetchImpl,
    sleep: config.sleep,
    retryRateLimit: true,
  });
  const model = config.model || OPENAI_DECISIONS_MODEL;
  const framing = judgeFraming(config.framing);
  const minConfidence = config.minConfidence ?? OPENAI_MIN_CONFIDENCE;
  const maxInputTokens = config.maxInputTokens ?? OPENAI_MAX_INPUT_TOKENS_PER_RUN;
  const maxDurationMs = config.maxDurationMs ?? JUDGE_MAX_DURATION_MS;
  const concurrency = Math.max(1, config.concurrency ?? OPENAI_CONCURRENCY);
  const now = config.now ?? Date.now;

  return {
    model,
    capacity: (corpus) => {
      const typical = judgeOptions({ query: "", shortlist: [] }, corpus, (_query, depth) =>
        corpus.slice(0, depth).map((entry) => entry.entryId),
      );
      const request = buildDecisionRequest(
        {
          input: `${framing.about}\n\nSearch query: ${"x".repeat(60)}`,
          instructions: framing.question,
          options: typical.map(decisionOption),
        },
        model,
      );
      // ~1.15 questions per ask: the re-read of the top options is small.
      const perCase = Math.ceil((JSON.stringify(request).length / 3.5) * 1.15);
      return Math.floor(maxInputTokens / Math.max(1, perCase));
    },
    judge: async (cases, corpus) => {
      const deadline = now() + maxDurationMs;
      const bm25 = corpus.length > JUDGE_MAX_OPTIONS ? bm25Order(corpus) : () => [];
      const verdicts: JudgeVerdict[] = [];
      let next = 0;
      let inputTokens = 0;
      let unanswered = 0;
      let refused = 0;
      let consecutiveFailures = 0;
      let stopped: "budget" | "deadline" | null = null;
      let fatal: unknown = null;

      async function judgeOne(row: JudgeCase): Promise<void> {
        const options = judgeOptions(row, corpus, bm25).map(decisionOption);
        try {
          const result = await client.decideChoice(row.query, options, framing);
          inputTokens += result.inputTokens;
          consecutiveFailures = 0;
          if (!result.answer) {
            refused += 1;
            verdicts.push({ id: row.id, entryId: "", confident: false });
            return;
          }
          verdicts.push(verdictFrom(row.id, result.answer, minConfidence));
        } catch (err) {
          if (err instanceof DecisionCallError && err.reason === "credentials") {
            throw new OpenAIJudgeAuthError(err.message);
          }
          logger.warn({ err }, "openai judging request failed");
          unanswered += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= OPENAI_MAX_CONSECUTIVE_FAILURES) {
            throw new OpenAIJudgeUnavailableError(
              `OpenAI answered none of the last ${consecutiveFailures} asks`,
            );
          }
        }
      }

      async function worker(): Promise<void> {
        while (next < cases.length && fatal === null && stopped === null) {
          if (inputTokens >= maxInputTokens) stopped = "budget";
          else if (now() >= deadline) stopped = "deadline";
          if (stopped !== null) return;
          const row = cases[next];
          next += 1;
          if (!row) return;
          try {
            await judgeOne(row);
          } catch (err) {
            fatal = err;
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, worker));
      if (fatal !== null) throw fatal;
      if (verdicts.length === 0 && unanswered > 0) {
        throw new OpenAIJudgeUnavailableError(`OpenAI answered none of ${unanswered} asks`);
      }

      const answered = verdicts.filter((verdict) => verdict.entryId !== "").length;
      logger.info(
        {
          model,
          cases: cases.length,
          answered,
          abstained: verdicts.length - answered,
          refused,
          unanswered,
          not_asked: cases.length - verdicts.length - unanswered,
          input_tokens: inputTokens,
          usd: Number((inputTokens * OPENAI_USD_PER_INPUT_TOKEN).toFixed(4)),
        },
        "openai judging finished",
      );
      if (stopped !== null) {
        logger.warn(
          { model, reason: stopped, input_tokens: inputTokens, not_asked: cases.length - next },
          "openai judging stopped early",
        );
      }
      return verdicts;
    },
  };
}
