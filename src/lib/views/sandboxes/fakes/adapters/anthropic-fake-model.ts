import type Anthropic from "@anthropic-ai/sdk";
import { anthropicUsage, trackModelCall } from "@/lib/platform/model-call";
import type { AnthropicClient } from "@/lib/readings/anthropic/client";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import {
  FAKE_OUTPUT_SCHEMA,
  FAKE_SYSTEM,
  fakeUserPrompt,
  parseFakeOutput,
} from "../domain/generation";
import type { FakeModel } from "../ports/fake-model";

/**
 * The generator on Claude: the small model (the eval gate's stand-in model,
 * `DEFAULT_JUDGE_MODEL` in `lib/eval-gate/models.ts`), structured output, low
 * effort. Each call is one `model_call` line with feature `sandbox_fake` and
 * payer `ratel`. The prompt carries customer tool data, so the call's span
 * gets no content.
 */

export const DEFAULT_FAKE_MODEL = "claude-haiku-5-5";
export const FAKE_FEATURE = "sandbox_fake";
const FAKE_MAX_TOKENS = 4_096;

export function anthropicFakeModel(
  client: AnthropicClient,
  model: string = DEFAULT_FAKE_MODEL,
): FakeModel {
  return {
    async generate(input, meta) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: FAKE_MAX_TOKENS,
        system: FAKE_SYSTEM,
        messages: [{ role: "user", content: fakeUserPrompt(input) }],
        output_config: {
          format: {
            type: "json_schema",
            schema: FAKE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
          },
          effort: "low",
        },
      };
      const message = await trackModelCall(
        {
          provider: "anthropic",
          model,
          feature: FAKE_FEATURE,
          payer: "ratel",
          projectId: meta.projectId,
          organizationId: meta.organizationId,
        },
        () => client.messages.create(wellFormedJson(request)),
        anthropicUsage,
      );
      if (message.stop_reason === "refusal") throw new Error("the fake model declined the request");
      if (message.stop_reason === "max_tokens")
        throw new Error("the fake answer exceeded the output token limit");
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      return parseFakeOutput(text, input.ledger);
    },
  };
}
