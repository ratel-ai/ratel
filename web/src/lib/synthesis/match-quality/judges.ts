import { type Config, getConfig } from "@/config";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { OPENAI_USD_PER_INPUT_TOKEN } from "@/lib/readings/decisions/openai";
import { openaiJudgeEngine } from "@/lib/readings/decisions/openai-judge";

/** Per-run settings the engine is built with. */
export interface JudgeRunOptions {
  /** Dollars this run may spend on judging. Absent means the engine's own default. */
  budgetUsd?: number;
}

/** The judge's questions, on each `model_call` log line. */
const MATCH_QUALITY_JUDGE_FEATURE = "match_quality_judge";

/**
 * The judge this deployment can plug in, or undefined with no key: a run then stops before
 * judging. Owned (ADR-0004): OpenAI is the one decision engine here.
 */
export function resolveJudgeEngine(
  config: Pick<Config, "openai"> = getConfig(),
  run: JudgeRunOptions = {},
): JudgeEngine | undefined {
  const { apiKey, baseUrl, decisionsModel } = config.openai;
  if (!apiKey) return undefined;
  return openaiJudgeEngine({
    apiKey,
    baseUrl,
    model: decisionsModel,
    feature: MATCH_QUALITY_JUDGE_FEATURE,
    ...(run.budgetUsd === undefined
      ? {}
      : { maxInputTokens: Math.floor(run.budgetUsd / OPENAI_USD_PER_INPUT_TOKEN) }),
  });
}
