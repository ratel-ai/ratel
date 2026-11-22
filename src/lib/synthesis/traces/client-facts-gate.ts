import type { OtelSpan } from "@/lib/ingest/otlp/schema";

/**
 * The client facts of a span (RC-773, RC-774) reach the trace page only with
 * `FF_AGENTS_PAGES` on (RC-1013; upstream's `cloud-project-entities`). Ingest
 * fills them with the switch off, so the gate is on the read: off, every fact
 * is null and the span detail renders as before the switch. No span holds a
 * caller's IP: ingest reads its country and drops it (RP-138).
 */

/** The `otel_spans` columns a span detail's Client block reads. */
export const CLIENT_FACT_FIELDS = [
  "harness",
  "harnessRaw",
  "harnessVersion",
  "harnessSource",
  "geoCountry",
  "mcpTransport",
  "mcpProtocolVersion",
] as const satisfies readonly (keyof OtelSpan)[];

type ClientFactField = (typeof CLIENT_FACT_FIELDS)[number];

const NO_CLIENT_FACTS = Object.fromEntries(
  CLIENT_FACT_FIELDS.map((field) => [field, null]),
) as Record<ClientFactField, null>;

/** The spans as loaded with `enabled`, else with every client fact null. */
export function gateClientFacts<T extends Pick<OtelSpan, ClientFactField>>(
  spans: readonly T[],
  enabled: boolean,
): T[] {
  return enabled ? [...spans] : spans.map((span) => ({ ...span, ...NO_CLIENT_FACTS }));
}
