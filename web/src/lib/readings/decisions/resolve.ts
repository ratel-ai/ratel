import { type Config, getConfig } from "@/config";
import { choiceClient } from "./choice";
import { resolveDecisionEngine, usdPerInputToken } from "./engine";
import type { JudgeEngine, JudgeFraming } from "./judge";
import { judgeEngineOver, openaiJudgeEngine } from "./openai-judge";
import { DECISION_VENDORS } from "./vendors";

/**
 * The judge this deployment's decision vendor gives a surface (ADR-0009 §10): the match-quality
 * judge, the workflow decisions and the topic placement all build theirs here, so one setting
 * moves all three. Null when no engine is usable; the surface then reports itself as not
 * measured.
 */

/** The threshold of an engine whose confidence is a score, not yet measured against an answer key. */
export const UNMEASURED_MIN_CONFIDENCE = 0.9;

export interface JudgeOptions {
  /** What the questions are for, on each `model_call` log line. */
  feature: string;
  /** Another question than the tuned tool-search one. */
  framing?: JudgeFraming;
  /** The most input tokens one run may spend. Absent is the engine's own default. */
  maxInputTokens?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function judgeFromConfig(
  config: Config = getConfig(),
  options: JudgeOptions,
): JudgeEngine | null {
  const resolved = resolveDecisionEngine(config);
  if (!resolved) return null;
  const minConfidence = config.decisions.minConfidence;
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
      usdPerInputToken: usdPerInputToken(resolved.name, config),
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
