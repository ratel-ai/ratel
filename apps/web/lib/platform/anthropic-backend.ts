import { configured } from "@/lib/platform/env-configured";

/**
 * Which backend serves this deployment's Claude calls. A leaf module, so the
 * `model_call` recorder can read it without importing the clients (and the
 * decision engines that import the recorder back). Call sites get it through
 * `@/lib/anthropic/client`.
 */

export type AnthropicBackend = "api" | "bedrock";

type Env = Record<string, string | undefined>;

/** `bedrock` when `ANTHROPIC_BACKEND=bedrock`, else `api`: the only backend a client can then have. */
export function anthropicBackend(env: Env = process.env): AnthropicBackend {
  return configured(env.ANTHROPIC_BACKEND) === "bedrock" ? "bedrock" : "api";
}
