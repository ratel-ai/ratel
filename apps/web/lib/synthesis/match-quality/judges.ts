import { resolveDecisionEngine, usdPerInputToken } from "@/lib/readings/decisions/engine";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { judgeFromEnv } from "@/lib/readings/decisions/resolve";

type Env = Record<string, string | undefined>;

/** Per-run settings the engine is built with. */
export interface JudgeRunOptions {
  /** Dollars this run may spend on judging. Absent means the engine's own default. */
  budgetUsd?: number;
}

/** The judge's questions, on each `model_call` log line. */
const MATCH_QUALITY_JUDGE_FEATURE = "match_quality_judge";

/**
 * The judge this deployment can plug in, or undefined with no usable engine: a run then stops
 * before judging. Owned (ADR-0030, ADR-0033): the vendor is the one `DECISION_PROVIDER` names
 * (`readings/decisions/engine.ts`), OpenAI's Decisions API unless told otherwise.
 */
export function resolveJudgeEngine(
  env: Env = process.env,
  run: JudgeRunOptions = {},
): JudgeEngine | undefined {
  const resolved = resolveDecisionEngine(env);
  if (!resolved) return undefined;
  return (
    judgeFromEnv(env, {
      feature: MATCH_QUALITY_JUDGE_FEATURE,
      ...(run.budgetUsd === undefined
        ? {}
        : { maxInputTokens: Math.floor(run.budgetUsd / usdPerInputToken(resolved.name, env)) }),
    }) ?? undefined
  );
}
