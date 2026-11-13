import Anthropic from "@anthropic-ai/sdk";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { anthropicUsage, recordModelCall, trackModelCall } from "@/lib/platform/model-call";
import { ANALYST_SCHEMA } from "@/lib/synthesis/match-quality/analyst";
import type { ModelUsage } from "@/lib/views/eval-gate/models";
import { anthropicKey, mockModelsEnabled } from "@/lib/views/eval-gate/models";

type Env = Record<string, string | undefined>;

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
 * Owned (ADR-0030): with `EVAL_GATE_MOCK_MODEL=1` outside production, a deterministic
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

/** Whether a draft can be made here: the local stand-in, or an Anthropic key. */
export function draftModelAvailable(
  env: Env = process.env,
  environment: string = deploymentEnvironment(),
): boolean {
  return mockModelsEnabled(env, environment) || !!anthropicKey(env);
}

/**
 * The draft model this deployment has. Owned (ADR-0030): upstream always builds the Anthropic
 * client, which with no key fails only at the request; here no key is no model (`null`), so
 * nothing is reserved or sent. The placeholder key is no key.
 */
export function draftModelFromEnv(
  env: Env = process.env,
  environment: string = deploymentEnvironment(),
  tools: ReadonlyArray<{ entryId: string; searchable: string }> = [],
): DraftModel | null {
  if (mockModelsEnabled(env, environment)) return standInDraftModel(tools);
  const apiKey = anthropicKey(env);
  if (!apiKey) return null;
  const model = env.EVAL_GATE_DRAFT_MODEL || DEFAULT_DRAFT_MODEL;
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    model,
    async complete({ system, user, maxTokens }) {
      const message = await trackModelCall(
        { provider: "anthropic", model, feature: DRAFT_FEATURE },
        () =>
          client.messages.create({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: user }],
            output_config: {
              format: { type: "json_schema", schema: ANALYST_SCHEMA },
              effort: "low",
            },
          }),
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
export function recordNoDraftKey(env: Env = process.env): void {
  recordModelCall({
    provider: "anthropic",
    model: env.EVAL_GATE_DRAFT_MODEL || DEFAULT_DRAFT_MODEL,
    feature: DRAFT_FEATURE,
    outcome: "skipped_no_key",
    durationMs: 0,
    calls: 1,
  });
}
