/**
 * What is common to every entity key (an agent, an MCP server): where a value
 * came from, and which values can never be a key.
 */

/** How a dimension was detected. */
export type DetectSource =
  /** A field the Ratel SDK sets. */
  | "sdk"
  /** An OpenTelemetry attribute that names the entity. */
  | "semconv"
  /** Inferred: a span name, the service name as the agent, a tool-name prefix. */
  | "heuristic";

const MAX_KEY = 256;
/** The OTel SDK default for a process with no service name: `unknown_service` or `unknown_service:<process>`. */
const UNKNOWN_SERVICE = /^unknown_service(?::|$)/;

/** The value as an entity key, or null when it is empty or the OTel default service name. */
export function entityKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  if (!key || UNKNOWN_SERVICE.test(key)) return null;
  return key.slice(0, MAX_KEY);
}
