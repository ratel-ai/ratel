import { type Config, getConfig } from "@/config";
import { resolveDecisionEngine, usdPerInputToken } from "@/lib/readings/decisions/engine";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { judgeFromConfig } from "@/lib/readings/decisions/resolve";

/** Per-run settings the engine is built with. */
export interface JudgeRunOptions {
  /** Dollars this run may spend on judging. Absent means the engine's own default. */
  budgetUsd?: number;
}

/** The judge's questions, on each `model_call` log line. */
const MATCH_QUALITY_JUDGE_FEATURE = "match_quality_judge";

/**
 * The judge this deployment can plug in, or undefined with no usable vendor: a run then stops
 * before judging. Owned (ADR-0004, ADR-0009): the vendor is the one `decisions.vendor` names
 * (`readings/decisions/engine.ts`), OpenAI's Decisions API unless told otherwise.
 */
export function resolveJudgeEngine(
  config: Config = getConfig(),
  run: JudgeRunOptions = {},
): JudgeEngine | undefined {
  const resolved = resolveDecisionEngine(config);
  if (!resolved) return undefined;
  return (
    judgeFromConfig(config, {
      feature: MATCH_QUALITY_JUDGE_FEATURE,
      ...(run.budgetUsd === undefined
        ? {}
        : { maxInputTokens: Math.floor(run.budgetUsd / usdPerInputToken(resolved.name, config)) }),
    }) ?? undefined
  );
}
