import { type Config, getConfig } from "@/config";

/**
 * Which backend serves this deployment's Claude calls. A leaf module, so the
 * `model_call` recorder can read it without importing the clients (and the
 * decision engines that import the recorder back). Call sites get it through
 * `@/lib/anthropic/client`.
 */

export type AnthropicBackend = "api" | "bedrock";

/** `bedrock` when `anthropic.backend` (ANTHROPIC_BACKEND) is `bedrock`, else `api`: the only backend a client can then have. */
export function anthropicBackend(
  config: Pick<Config, "anthropic"> = getConfig(),
): AnthropicBackend {
  return config.anthropic.backend === "bedrock" ? "bedrock" : "api";
}
