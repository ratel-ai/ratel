import { trace } from "@opentelemetry/api";
import { configHash } from "./hash.js";
import { hashableTools } from "./tools.js";

export const RATEL_TWIN_ID = "ratel.twin.id";
export const RATEL_TWIN_CONFIG_HASH = "ratel.twin.config_hash";
export const RATEL_TWIN_INPUT = "ratel.twin.input";
/** Playground runs only (spec §10): the run, the changed param names, the replay source. */
export const RATEL_TWIN_RUN_ID = "ratel.twin.run_id";
export const RATEL_TWIN_OVERRIDES = "ratel.twin.overrides";
export const RATEL_REPLAY_SOURCE_TRACE_ID = "ratel.replay.source_trace_id";
export const RATEL_REPLAY_SOURCE_SESSION_ID = "ratel.replay.source_session_id";
export const RATEL_REPLAY_ARM = "ratel.replay.arm";

/** Default cap of the stamped input JSON, in characters. */
export const TWIN_INPUT_MAX_CHARS = 8000;

const hashes = new WeakMap<object, string>();

/**
 * The production path of a twin's config: returns `defaults` unchanged and
 * stamps `ratel.twin.id` and `ratel.twin.config_hash` on the active span. The
 * hash is computed once per defaults object. No span: no stamp. No I/O.
 */
export function resolveLocal<D extends Readonly<Record<string, unknown>>>(
  defaults: D,
  options: { twin: string },
): D {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(RATEL_TWIN_ID, options.twin);
    span.setAttribute(RATEL_TWIN_CONFIG_HASH, memoizedHash(defaults));
  }
  return defaults;
}

/** Stamps `ratel.twin.input` (the input JSON, capped at maxChars) on the active span of a structured item call. */
export function stampTwinInput(input: unknown, options: { maxChars?: number } = {}): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const json = JSON.stringify(input) ?? "null";
  span.setAttribute(RATEL_TWIN_INPUT, json.slice(0, options.maxChars ?? TWIN_INPUT_MAX_CHARS));
}

function memoizedHash(defaults: object): string {
  let hash = hashes.get(defaults);
  if (hash === undefined) {
    // A production toolset hashes as its tool names and descriptions, like a tools param.
    const values = Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [k, hashableTools(v) ?? v]),
    );
    hash = configHash(values);
    hashes.set(defaults, hash);
  }
  return hash;
}
