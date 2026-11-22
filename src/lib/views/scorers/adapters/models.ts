import { getLogger } from "@/lib/platform/logger";
import { configured, resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { openaiJudgeEngine } from "@/lib/readings/decisions/openai-judge";
import {
  type EvalGateFeature,
  estimateTokens,
  type JudgeModel,
  ModelRefused,
  type ModelUsage,
  recordBudgetRefusal,
  SMALL_MAX_TOKENS,
  type SpendMeter,
} from "@/lib/views/eval-gate/models";
import type { DecisionPort, JudgePort } from "../ports";

/**
 * The model-based kinds' ports over Cloud's own models: the eval gate's judge
 * model for `judge`, and the decision engine (`DECISION_ENGINE`) for
 * `decision`. Budgets stay with the caller: it passes `onUsage` and decides
 * whether to call at all.
 *
 * Owned (ADR-0030): the decision engine is OpenAI's, the one engine of the core
 * (`readings/decisions/engine.ts`); upstream also runs the Cloud's private engines.
 */

const logger = getLogger("scorers/models");

const DECISION_FEATURE = "scorer_decision";
/** The judge's own instructions, for its estimate (as lib/eval-gate/judge.ts). */
const JUDGE_PROMPT_TOKENS = 400;
/** One decision scorer's run reads one transcript: about 20k characters at most. */
const DECISION_MAX_INPUT_TOKENS = 200_000;
const DECISION_ABOUT =
  "A run of an AI agent, in plain words: its messages, its tool calls with arguments and results, its final answer and its measurements.";

export type DecisionEngineFactory = (framing: {
  about: string;
  question: string;
}) => JudgeEngine | null;

/** The eval gate's judge model as a judge port. Its verdict is pass or fail, so the value is 1 or 0. */
export function judgePortOf(
  model: JudgeModel,
  onUsage?: (model: string, usage: ModelUsage) => void,
): JudgePort {
  return {
    async judge({ criteria, transcript }) {
      const verdict = await model.judge({ criteria, run: transcript });
      onUsage?.(model.model, verdict.usage);
      return {
        value: verdict.pass ? 1 : 0,
        detail: verdict.pass ? "meets the criteria" : "misses the criteria",
      };
    },
  };
}

/**
 * The judge model as a judge port that holds each call's worst case on a
 * spend meter first. A refused hold or a refused key gives a skip.
 */
export function meteredJudgePort(
  model: JudgeModel,
  meter: SpendMeter,
  feature: EvalGateFeature = "eval_gate_judge",
): JudgePort {
  return {
    async judge({ criteria, transcript }) {
      const hold = await meter.reserve(model.model, {
        inputTokens: JUDGE_PROMPT_TOKENS + estimateTokens(criteria, transcript),
        outputTokens: SMALL_MAX_TOKENS,
      });
      if (!hold) {
        recordBudgetRefusal(model, feature);
        return null;
      }
      try {
        const verdict = await model.judge({ criteria, run: transcript });
        meter.settle(hold, model.model, verdict.usage);
        return {
          value: verdict.pass ? 1 : 0,
          detail: verdict.pass ? "meets the criteria" : "misses the criteria",
        };
      } catch (err) {
        meter.release(hold);
        if (err instanceof ModelRefused) return null;
        throw err;
      }
    },
  };
}

/** A decision engine as a decision port. The engine declining to choose gives a skip. */
export function decisionPortOf(engineFor: DecisionEngineFactory): DecisionPort {
  return {
    async decide({ question, options, transcript }) {
      const engine = engineFor({ about: DECISION_ABOUT, question });
      if (!engine) return null;
      const corpus = options.map((option) => ({
        entryId: option.id,
        name: option.label,
        searchable: option.label,
        source: "description",
        matchesAgentDescription: true,
        tags: [],
      }));
      const [verdict] = await engine.judge(
        [
          {
            id: "run",
            query: transcript,
            shortlist: options.map((option) => option.id),
            assumed: options[0]!.id,
            stratum: "control",
          },
        ],
        corpus,
      );
      if (!verdict?.entryId) {
        logger.info(
          { engine: engine.model, options: options.length },
          "decision scorer got no choice",
        );
        return null;
      }
      return { choice: verdict.entryId };
    },
  };
}

/** The decision engine (OpenAI's, the core's one), framed for one question. Null without a usable key. */
export function decisionEngineFromEnv(
  env: Record<string, string | undefined> = process.env,
): DecisionEngineFactory {
  return (framing) => {
    const resolved = resolveDecisionEngine(env);
    if (!resolved) return null;
    return openaiJudgeEngine({
      apiKey: resolved.apiKey,
      framing,
      feature: DECISION_FEATURE,
      maxInputTokens: DECISION_MAX_INPUT_TOKENS,
      minConfidence: 0,
      baseUrl: resolved.baseUrl,
      model: configured(env.OPENAI_DECISIONS_MODEL),
    });
  };
}
