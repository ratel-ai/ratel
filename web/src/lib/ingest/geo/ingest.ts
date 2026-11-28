import { type AddressLookup, loadAddressLookup } from "@/lib/ingest/geo/address";
import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import { loadReverseLookup } from "@/lib/ingest/geo/boundaries";
import { locateSpans } from "@/lib/ingest/geo/locate";
import { type RedactedExport, redactExport } from "@/lib/ingest/geo/redact";
import { loadGeoAttributes } from "@/lib/ingest/geo/store";
import type { OtlpTransport } from "@/lib/ingest/otlp/http";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

/** How long a project's attribute names are kept: a change takes effect within it. */
const NAMES_MS = 60_000;

export interface GeoIngestDeps {
  attributes(projectId: string): Promise<GeoAttributes>;
  address(): Promise<AddressLookup | null>;
  now(): number;
}

/**
 * What the ingest route and the queue's worker take. One for both, so that a process keeps one
 * cache of each project's attribute names.
 */
export const geoIngest = createGeoIngest({
  attributes: (projectId) => loadGeoAttributes(projectId),
  address: () => loadAddressLookup(),
  now: Date.now,
});

export function createGeoIngest(deps: GeoIngestDeps) {
  const names = new Map<string, { attributes: GeoAttributes; at: number }>();

  return { locate, redact };

  /** Marks the spans of a batch that is about to be stored. */
  async function locate(
    projectId: string,
    spans: readonly DecodedSpan[],
  ): Promise<{ addressed: boolean }> {
    return locateSpans(spans, await attributesOf(projectId), await lookups());
  }

  /** An export that is about to be queued, located and without what must not be stored. */
  async function redact(
    projectId: string,
    transport: OtlpTransport,
    bytes: Uint8Array,
  ): Promise<RedactedExport | null> {
    return redactExport(transport, bytes, await attributesOf(projectId), await lookups());
  }

  async function lookups() {
    return { address: await deps.address(), reverse: loadReverseLookup };
  }

  async function attributesOf(projectId: string): Promise<GeoAttributes> {
    const now = deps.now();
    const kept = names.get(projectId);
    if (kept && now - kept.at < NAMES_MS) return kept.attributes;
    const attributes = await deps.attributes(projectId);
    names.set(projectId, { attributes, at: now });
    return attributes;
  }
}
