import { trace } from "@opentelemetry/api";
import { configHash } from "./hash.js";

export const RATEL_TWIN_ID = "ratel.twin.id";
export const RATEL_TWIN_CONFIG_HASH = "ratel.twin.config_hash";
export const RATEL_TWIN_INPUT = "ratel.twin.input";

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
    hash = configHash(defaults as Record<string, unknown>);
    hashes.set(defaults, hash);
  }
  return hash;
}
