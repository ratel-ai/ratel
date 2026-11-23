import { choiceClient } from "./choice";
import { configured, resolveDecisionEngine, usdPerInputToken } from "./engine";
import type { JudgeEngine, JudgeFraming } from "./judge";
import { judgeEngineOver, openaiJudgeEngine } from "./openai-judge";
import { DECISION_VENDORS } from "./vendors";

/**
 * The judge this deployment's decision vendor gives a surface (ADR-0033 §10): the match-quality
 * judge, the workflow decisions and the topic placement all build theirs here, so one setting
 * moves all three. Null when no engine is usable; the surface then reports itself as not
 * measured.
 */

type Env = Record<string, string | undefined>;

/** The threshold of an engine whose confidence is a score, not yet measured against an answer key. */
export const UNMEASURED_MIN_CONFIDENCE = 0.9;

export interface JudgeFromEnvOptions {
  /** What the questions are for, on each `model_call` log line. */
  feature: string;
  /** Another question than the tuned tool-search one. */
  framing?: JudgeFraming;
  /** The most input tokens one run may spend. Absent is the engine's own default. */
  maxInputTokens?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** `DECISION_MIN_CONFIDENCE`, when it is a number between 0 and 1. */
function minConfidenceFrom(env: Env): number | undefined {
  const raw = configured(env.DECISION_MIN_CONFIDENCE);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

export function judgeFromEnv(
  env: Env = process.env,
  options: JudgeFromEnvOptions,
): JudgeEngine | null {
  const resolved = resolveDecisionEngine(env);
  if (!resolved) return null;
  const minConfidence = minConfidenceFrom(env);
  const shared = {
    ...(options.framing ? { framing: options.framing } : {}),
    ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
  };

  if (resolved.name !== "openai") {
    const client = choiceClient({
      vendor: resolved.name,
      baseUrl: resolved.baseUrl,
      // The resolver gives no engine without a model for this one.
      model: resolved.model ?? "",
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      retryRateLimit: true,
      feature: options.feature,
    });
    return judgeEngineOver(client, client.model, {
      ...shared,
      minConfidence: minConfidence ?? UNMEASURED_MIN_CONFIDENCE,
      usdPerInputToken: usdPerInputToken(resolved.name, env),
      label: DECISION_VENDORS[resolved.name].label,
    });
  }

  return openaiJudgeEngine({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    feature: options.feature,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    ...shared,
    ...(minConfidence === undefined ? {} : { minConfidence }),
  });
}
