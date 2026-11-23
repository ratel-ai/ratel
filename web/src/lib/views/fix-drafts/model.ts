import type Anthropic from "@anthropic-ai/sdk";
import { type Config, getConfig } from "@/config";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { anthropicUsage, recordModelCall, trackModelCall } from "@/lib/platform/model-call";
import { anthropicContent } from "@/lib/platform/model-call-content";
import { anthropicClient, anthropicConfigured } from "@/lib/readings/anthropic/client";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import { ANALYST_SCHEMA } from "@/lib/synthesis/match-quality/analyst";
import type { ModelUsage } from "@/lib/views/eval-gate/models";
import { mockModelsEnabled } from "@/lib/views/eval-gate/models";

export const DEFAULT_DRAFT_MODEL = "claude-sonnet-5-5";
export const DRAFT_MAX_TOKENS = 1024;
export const DRAFT_BUDGET_USD = 0.05;
export const DRAFT_FEATURE = "eval_gate_fix_draft";

export interface DraftModel {
  model: string;
  complete(input: {
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: ModelUsage }>;
}

/** The text a stand-in adds to each tool's searchable description. */
export const STAND_IN_SUFFIX = "Use it when the request names what this tool does.";

/**
 * Owned (ADR-0004): with `EVAL_GATE_MOCK_MODEL=1` outside production, a deterministic
 * stand-in that proposes each tool's own text plus a fixed sentence, with no network.
 */
export function standInDraftModel(
  tools: ReadonlyArray<{ entryId: string; searchable: string }>,
): DraftModel {
  return {
    model: DEFAULT_DRAFT_MODEL,
    async complete() {
      const proposals = tools.map((tool) => ({
        entryId: tool.entryId,
        searchableDescription: `${tool.searchable.trim()} ${STAND_IN_SUFFIX}`.trim(),
        rationale: "Local stand-in draft.",
        details: "EVAL_GATE_MOCK_MODEL=1: no model was called.",
      }));
      return {
        text: JSON.stringify({
          diagnosis: { headline: "Local stand-in draft.", points: [] },
          proposals,
        }),
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

/** Whether a draft can be made here: the local stand-in, or a Claude backend. */
export function draftModelAvailable(
  config: Pick<Config, "anthropic" | "evalGate"> = getConfig(),
  environment: string = deploymentEnvironment(),
): boolean {
  return mockModelsEnabled(config, environment) || anthropicConfigured(config);
}

/**
 * The draft model this deployment has. Owned (ADR-0004): upstream fails only at the request when
 * no Claude backend is configured; here no backend is no model (`null`), so nothing is reserved
 * or sent. The placeholder key is no key.
 */
export function draftModelFromEnv(
  config: Pick<Config, "anthropic" | "evalGate"> = getConfig(),
  environment: string = deploymentEnvironment(),
  tools: ReadonlyArray<{ entryId: string; searchable: string }> = [],
): DraftModel | null {
  if (mockModelsEnabled(config, environment)) return standInDraftModel(tools);
  const client = anthropicClient({ maxRetries: 0 }, config);
  if (!client) return null;
  const model = config.evalGate.draftModel || DEFAULT_DRAFT_MODEL;
  return {
    model,
    async complete({ system, user, maxTokens }) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema: ANALYST_SCHEMA }, effort: "low" },
      };
      const message = await trackModelCall(
        {
          provider: "anthropic",
          model,
          feature: DRAFT_FEATURE,
          payer: "ratel",
          content: anthropicContent(request),
        },
        () => client.messages.create(wellFormedJson(request)),
        anthropicUsage,
      );
      if (message.stop_reason === "refusal")
        throw new Error("The model refused the draft request.");
      if (message.stop_reason === "max_tokens")
        throw new Error("The draft exceeded the output token limit.");
      return {
        text: message.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join(""),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    },
  };
}

/** A draft never made because no Anthropic key is configured, as one `model_call` line. */
export function recordNoDraftKey(config: Pick<Config, "evalGate"> = getConfig()): void {
  recordModelCall({
    provider: "anthropic",
    model: config.evalGate.draftModel || DEFAULT_DRAFT_MODEL,
    feature: DRAFT_FEATURE,
    payer: "ratel",
    outcome: "skipped_no_key",
    durationMs: 0,
    calls: 1,
  });
}
