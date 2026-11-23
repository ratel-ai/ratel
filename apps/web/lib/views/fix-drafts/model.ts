import { deploymentEnvironment } from "@/lib/platform/environment";
import { recordModelCall } from "@/lib/platform/model-call";
import { models, providerFor } from "@/lib/readings/models";
import { ANALYST_SCHEMA } from "@/lib/synthesis/match-quality/analyst";
import type { ModelUsage } from "@/lib/views/eval-gate/models";
import { mockModelsEnabled } from "@/lib/views/eval-gate/models";

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

/** Whether a draft can be made here: the local stand-in, or a Claude backend. */
export function draftModelAvailable(
  env: Env = process.env,
  environment: string = deploymentEnvironment(),
): boolean {
  return (
    mockModelsEnabled(env, environment) || models.text(DRAFT_FEATURE, { env, environment }) !== null
  );
}

/**
 * The draft model this deployment has. Owned (ADR-0030): upstream fails only at the request when
 * no Claude backend is configured; here no backend is no model (`null`), so nothing is reserved
 * or sent. The placeholder key is no key.
 */
export function draftModelFromEnv(
  env: Env = process.env,
  environment: string = deploymentEnvironment(),
  tools: ReadonlyArray<{ entryId: string; searchable: string }> = [],
): DraftModel | null {
  if (mockModelsEnabled(env, environment)) return standInDraftModel(tools);
  const text = models.text(DRAFT_FEATURE, { env, environment });
  if (!text) return null;
  return {
    model: text.model,
    async complete({ system, user, maxTokens }) {
      const reply = await text.complete({
        system,
        user,
        schema: ANALYST_SCHEMA,
        effort: "low",
        maxTokens,
        maxRetries: 0,
      });
      if (reply.stop === "refused") throw new Error("The model refused the draft request.");
      if (reply.stop === "cut_off") throw new Error("The draft exceeded the output token limit.");
      return {
        text: reply.text,
        usage: { inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens },
      };
    },
  };
}

/** A draft never made because no vendor is configured, as one `model_call` line. */
export function recordNoDraftKey(env: Env = process.env): void {
  recordModelCall({
    provider: providerFor(DRAFT_FEATURE, { env }),
    model: env.EVAL_GATE_DRAFT_MODEL || DEFAULT_DRAFT_MODEL,
    feature: DRAFT_FEATURE,
    payer: "ratel",
    outcome: "skipped_no_key",
    durationMs: 0,
    calls: 1,
  });
}
