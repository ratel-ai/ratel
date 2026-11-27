import { type AddressLookup, loadAddressLookup } from "@/lib/ingest/geo/address";
import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import { loadReverseLookup } from "@/lib/ingest/geo/boundaries";
import { locateSpans } from "@/lib/ingest/geo/locate";
import { type RedactedExport, redactExport } from "@/lib/ingest/geo/redact";
import { loadGeoAttributes } from "@/lib/ingest/geo/store";
import type { OtlpTransport } from "@/lib/ingest/otlp/http";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { featureEnabled } from "@/lib/platform/experimental-features";

/** How long an organization's flag decision is kept: the flag port may be a slow network call. */
const DECISION_MS = 5 * 60_000;
/** How long a project's attribute names are kept: a change takes effect within it. */
const NAMES_MS = 60_000;

type IngestOrganization = { id?: string } | string | null | undefined;

export interface GeoIngestDeps {
  /** Whether `customMonitoring` is on. Never rejects. */
  enabled(subject: { organizationId?: string }): Promise<boolean>;
  attributes(projectId: string): Promise<GeoAttributes>;
  address(): Promise<AddressLookup | null>;
  now(): number;
}

/**
 * What the ingest route and the queue's worker take. One for both, so that a process asks for an
 * organization's flag once. Nothing while `customMonitoring` is off.
 */
export const geoIngest = createGeoIngest({
  enabled: (subject) => featureEnabled("customMonitoring", subject),
  attributes: (projectId) => loadGeoAttributes(projectId),
  address: () => loadAddressLookup(),
  now: Date.now,
});

export function createGeoIngest(deps: GeoIngestDeps) {
  const decisions = new Map<string | undefined, { enabled: Promise<boolean>; at: number }>();
  const names = new Map<string, { attributes: GeoAttributes; at: number }>();

  return { locate, redact };

  /** Marks the spans of a batch that is about to be stored. */
  async function locate(
    projectId: string,
    organization: IngestOrganization,
    spans: readonly DecodedSpan[],
  ): Promise<{ addressed: boolean }> {
    if (!(await enabledFor(organization))) return { addressed: false };
    return locateSpans(spans, await attributesOf(projectId), await lookups());
  }

  /** An export that is about to be queued, located and without what must not be stored. */
  async function redact(
    projectId: string,
    organization: IngestOrganization,
    transport: OtlpTransport,
    bytes: Uint8Array,
  ): Promise<RedactedExport | null> {
    if (!(await enabledFor(organization))) return null;
    return redactExport(transport, bytes, await attributesOf(projectId), await lookups());
  }

  async function lookups() {
    return { address: await deps.address(), reverse: loadReverseLookup };
  }

  function enabledFor(organization: IngestOrganization): Promise<boolean> {
    const organizationId = typeof organization === "string" ? organization : organization?.id;
    const now = deps.now();
    const kept = decisions.get(organizationId);
    if (kept && now - kept.at < DECISION_MS) return kept.enabled;
    const enabled = deps.enabled(organizationId ? { organizationId } : {});
    decisions.set(organizationId, { enabled, at: now });
    return enabled;
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
