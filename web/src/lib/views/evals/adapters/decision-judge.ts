import { EVAL_JUDGE_FEATURE, type EvalJudgePort } from "@/lib/contracts/eval-judge";
import {
  type ResolvedDecisionEngine,
  resolveDecisionEngine,
  usdPerInputToken,
} from "@/lib/readings/decisions/engine";
import { decisionClient } from "@/lib/readings/decisions/openai";

/**
 * The core's judge: the configured decision engine. With none, there is no judge and no call. It
 * asks the engine directly, not through the `JudgeEngine` of the readings: that one frames its
 * case as a search query and returns no usage, which the budget needs.
 */
export function createDecisionJudge(
  engine: () => ResolvedDecisionEngine | null = resolveDecisionEngine,
  fetchImpl?: typeof fetch,
): EvalJudgePort {
  return {
    async judgeFor() {
      const resolved = engine();
      if (!resolved) return null;
      const client = decisionClient({
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        feature: EVAL_JUDGE_FEATURE,
        timeoutMs: 10_000,
        attempts: 2,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return {
        provider: "openai",
        model: client.model,
        payer: "ratel",
        usdPerInputToken: usdPerInputToken(resolved.name),
        async ask(request) {
          const { answer, inputTokens } = await client.ask(request);
          return { answer: answer === "refusal" ? null : answer, inputTokens };
        },
      };
    },
  };
}
