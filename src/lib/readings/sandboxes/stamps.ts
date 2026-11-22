import type { Attributes } from "@opentelemetry/api";
import {
  configHash,
  RATEL_SANDBOX_CONFIG_HASH,
  RATEL_SANDBOX_ID,
  RATEL_SANDBOX_INPUT,
} from "@ratel-ai/sandbox";
import { setAgentRunAttributes } from "@/lib/platform/agent-run";
import { MODEL_CALL_CONTENT_MAX_CHARS } from "@/lib/platform/model-call-content";
import { sliceWellFormed } from "@/lib/readings/text/well-formed";

/**
 * The production stamps of an agent sandbox (spec §3.7, RC-1091), behind
 * `cloud-sandboxes`.
 *
 * `@ratel-ai/sandbox`'s `resolveLocal` stamps the active span. A Cloud job's
 * `invoke_agent <job>` root is never active and is made lazily by the first
 * model call (lib/observability/agent-run.ts), so the stamps go through the
 * run instead: they wait for the root and land on it. The hash is the SDK's
 * own `configHash`, so a playground run with no edits has the same hash.
 */

/** Stamp `ratel.sandbox.id` and `ratel.sandbox.config_hash` on the current job's root; returns the hash. */
export function stampSandboxConfig(
  config: Readonly<Record<string, unknown>>,
  options: { sandbox: string },
): string {
  const hash = configHash(config);
  setAgentRunAttributes({ [RATEL_SANDBOX_ID]: options.sandbox, [RATEL_SANDBOX_CONFIG_HASH]: hash });
  return hash;
}

/**
 * `ratel.sandbox.input` for one item's model-call span: the input JSON, under the
 * rules of Ratel-paid content (RC-721): only Ratel-paid calls get a span, and
 * the value is capped at `MODEL_CALL_CONTENT_MAX_CHARS` and well-formed.
 */
export function sandboxInputAttributes(input: unknown): Attributes {
  const json = JSON.stringify(input) ?? "null";
  return {
    [RATEL_SANDBOX_INPUT]: sliceWellFormed(json, MODEL_CALL_CONTENT_MAX_CHARS).toWellFormed(),
  };
}
