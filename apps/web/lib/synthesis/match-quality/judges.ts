import { configured } from "@/lib/readings/decisions/engine";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { OPENAI_USD_PER_INPUT_TOKEN } from "@/lib/readings/decisions/openai";
import { openaiJudgeEngine } from "@/lib/readings/decisions/openai-judge";

type Env = Record<string, string | undefined>;

/** Per-run settings the engine is built with. */
export interface JudgeRunOptions {
  /** Dollars this run may spend on judging. Absent means the engine's own default. */
  budgetUsd?: number;
}

/**
 * The judge this deployment can plug in, or undefined with no key: a run then stops before
 * judging. Owned (ADR-0030): OpenAI is the one decision engine here.
 */
export function resolveJudgeEngine(
  env: Env = process.env,
  run: JudgeRunOptions = {},
): JudgeEngine | undefined {
  const apiKey = configured(env.OPENAI_API_KEY);
  if (!apiKey) return undefined;
  return openaiJudgeEngine({
    apiKey,
    baseUrl: configured(env.OPENAI_BASE_URL),
    model: configured(env.OPENAI_DECISIONS_MODEL),
    ...(run.budgetUsd === undefined
      ? {}
      : { maxInputTokens: Math.floor(run.budgetUsd / OPENAI_USD_PER_INPUT_TOKEN) }),
  });
}
