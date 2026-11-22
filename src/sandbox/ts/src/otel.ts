import { trace } from "@opentelemetry/api";
import { configHash } from "./hash.js";
import { hashableTools } from "./tools.js";

export const RATEL_SANDBOX_ID = "ratel.sandbox.id";
export const RATEL_SANDBOX_CONFIG_HASH = "ratel.sandbox.config_hash";
export const RATEL_SANDBOX_INPUT = "ratel.sandbox.input";
/** Playground runs only (spec §10): the run, the changed param names, the replay source. */
export const RATEL_SANDBOX_RUN_ID = "ratel.sandbox.run_id";
export const RATEL_SANDBOX_OVERRIDES = "ratel.sandbox.overrides";
export const RATEL_REPLAY_SOURCE_TRACE_ID = "ratel.replay.source_trace_id";
export const RATEL_REPLAY_SOURCE_SESSION_ID = "ratel.replay.source_session_id";
export const RATEL_REPLAY_ARM = "ratel.replay.arm";

/** Default cap of the stamped input JSON, in characters. */
export const SANDBOX_INPUT_MAX_CHARS = 8000;

const hashes = new WeakMap<object, string>();

/**
 * The production path of a sandbox's config: returns `defaults` unchanged and
 * stamps `ratel.sandbox.id` and `ratel.sandbox.config_hash` on the active span. The
 * hash is computed once per defaults object. No span: no stamp. No I/O.
 */
export function resolveLocal<D extends Readonly<Record<string, unknown>>>(
  defaults: D,
  options: { sandbox: string },
): D {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(RATEL_SANDBOX_ID, options.sandbox);
    span.setAttribute(RATEL_SANDBOX_CONFIG_HASH, localConfigHash(defaults));
  }
  return defaults;
}

/**
 * The config hash `resolveLocal` stamps for `defaults`: a toolset hashes as its
 * tool names and descriptions, like a tools param. Memoized per defaults object.
 */
export function localConfigHash(defaults: Readonly<Record<string, unknown>>): string {
  let hash = hashes.get(defaults);
  if (hash === undefined) {
    const values = Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [k, hashableTools(v) ?? v]),
    );
    hash = configHash(values);
    hashes.set(defaults, hash);
  }
  return hash;
}

/** Stamps `ratel.sandbox.input` (the input JSON, capped at maxChars) on the active span of a structured item call. */
export function stampSandboxInput(input: unknown, options: { maxChars?: number } = {}): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const json = JSON.stringify(input) ?? "null";
  span.setAttribute(
    RATEL_SANDBOX_INPUT,
    json.slice(0, options.maxChars ?? SANDBOX_INPUT_MAX_CHARS),
  );
}
