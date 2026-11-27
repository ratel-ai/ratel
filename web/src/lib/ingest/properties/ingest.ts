import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { enqueuePropertyFill } from "./fill";
import {
  detectPropertyKeys,
  NO_PROPERTY_VALUES,
  type PropertyValuesBySpan,
  propertyValues,
  storedPropertyNames,
} from "./keys";
import {
  type KeySighting,
  loadIndexedProperties,
  type RecordedKey,
  recordPropertyKeys,
} from "./store";

/** How long a key that was written is not written again by this process. */
export const SEEN_MS = 60 * 60_000;
/** How long an organization's flag decision is kept: the flag port may be a slow network call. */
const DECISION_MS = 5 * 60_000;
/** How long a project's indexed names are kept: a change takes effect within it. */
const INDEXED_MS = 60_000;
/** Most keys a project's cache holds; past it, the cache starts again. */
const MAX_CACHED_KEYS = 1_000;

const logger = getLogger("ingest/properties");

type IngestOrganization = { id?: string } | string | null | undefined;

export interface PropertyIngestDeps {
  /** Whether `customMonitoring` is on. Never rejects. */
  enabled(subject: { organizationId?: string }): Promise<boolean>;
  record(projectId: string, sightings: KeySighting[]): Promise<RecordedKey[]>;
  indexed(projectId: string): Promise<ReadonlySet<string>>;
  /** Start the fill of stored traces for standard properties this export indexed. Absent, none. */
  fill?(projectId: string, names: string[]): Promise<void>;
  now(): number;
}

interface SeenKey {
  at: number;
  /** Sightings since the last write, added to the next one. */
  pending: number;
}

/**
 * What the ingest route and the queue's worker take: one for both, so that a process keeps one
 * cache. Nothing while `customMonitoring` is off.
 */
export const propertyIngest = createPropertyIngest({
  enabled: (subject) => featureEnabled("customMonitoring", subject),
  record: (projectId, sightings) => recordPropertyKeys(projectId, sightings),
  indexed: (projectId) => loadIndexedProperties(projectId),
  // Best-effort: a fill that is not queued leaves old traces without the value, never the export.
  fill: (projectId, names) =>
    enqueuePropertyFill(projectId, names).catch((err) =>
      logger.error({ err, project_id: projectId }, "trace property fill enqueue failed"),
    ),
  now: Date.now,
});

export function createPropertyIngest(deps: PropertyIngestDeps) {
  const decisions = new Map<string | undefined, { enabled: Promise<boolean>; at: number }>();
  const seen = new Map<string, Map<string, SeenKey>>();
  const indexedNames = new Map<string, { names: Set<string>; at: number }>();

  return { capture };

  /**
   * Record the property keys of a batch that is about to be stored, and return the values of its
   * indexed properties for each span. At most one write and one read per export, none when every
   * key was written in the last hour and the indexed names were read in the last minute.
   */
  async function capture(
    projectId: string,
    organization: IngestOrganization,
    spans: readonly DecodedSpan[],
  ): Promise<PropertyValuesBySpan> {
    if (!(await enabledFor(organization))) return NO_PROPERTY_VALUES;
    const indexed = await indexedOf(projectId);
    const fresh: string[] = [];
    for (const { name, state, created } of await recordNew(projectId, detectPropertyKeys(spans))) {
      if (state !== "indexed") continue;
      indexed.add(name);
      if (created) fresh.push(name);
    }
    const stored = [...storedPropertyNames(fresh)];
    // Traces stored before this export may carry it in the raw store.
    if (stored.length > 0) await deps.fill?.(projectId, stored);
    return propertyValues(spans, storedPropertyNames(indexed));
  }

  async function recordNew(
    projectId: string,
    detected: ReadonlyMap<string, { source: KeySighting["source"]; count: number }>,
  ) {
    const now = deps.now();
    let keys = seen.get(projectId);
    if (!keys || keys.size > MAX_CACHED_KEYS) {
      keys = new Map();
      seen.set(projectId, keys);
    }
    const sightings: KeySighting[] = [];
    for (const [name, { source, count }] of detected) {
      const kept = keys.get(name);
      if (kept && now - kept.at < SEEN_MS) {
        kept.pending += count;
        continue;
      }
      sightings.push({ name, source, count: count + (kept?.pending ?? 0) });
    }
    if (sightings.length === 0) return [];
    const recorded = await deps.record(projectId, sightings);
    for (const { name } of sightings) keys.set(name, { at: now, pending: 0 });
    return recorded;
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

  async function indexedOf(projectId: string): Promise<Set<string>> {
    const now = deps.now();
    const kept = indexedNames.get(projectId);
    if (kept && now - kept.at < INDEXED_MS) return kept.names;
    const names = new Set(await deps.indexed(projectId));
    indexedNames.set(projectId, { names, at: now });
    return names;
  }
}
