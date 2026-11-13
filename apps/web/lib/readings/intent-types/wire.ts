import { createHash } from "node:crypto";
import { stableStringify } from "@/lib/ingest/trace-events/parse";

/**
 * Wire shape of the adaptive-ranking intent graph (open-source `protocol/v1`
 * `intent-graph.schema.json`, ADR-0014). Cloud stores the document exactly as a
 * runtime's `IntentGraph.toJson()` produced it and hands it back through
 * `IntentGraph.fromJson()`, so these types are deliberately open: every object
 * carries an index signature because the contract is additive and a consumer
 * MUST preserve fields it does not recognise.
 *
 * `members` holds raw user query text. Nothing in this module may log a member.
 */

/** One cluster: past queries plus weighted edges to the capabilities invoked after them. */
export interface IntentGraphIntent {
  /** Cluster id, unique within the graph. Opaque. */
  id: string;
  /** Display only: the medoid member on the wire, never read for ranking. */
  label: string;
  /** Display only: distinguishing keywords. */
  terms: string[];
  /** THE MATCH KEY. Raw query texts; the runtime matches incoming queries against these. */
  members: string[];
  /** L2-normalised mean embedding; absent for a lexically clustered graph. */
  centroid?: number[];
  /** Confirmed searches behind this cluster (one search with several invokes counts once). */
  support: number;
  /** Provenance only: how many of `support` came from a seeding pass. */
  seeded_support?: number;
  /** Epoch millis of the most recent observation; drives recency and eviction. */
  last_ts?: number;
  /** Tool id -> confirmed invocation count. */
  tools: Record<string, number>;
  /** Skill id -> confirmed invocation count. */
  skills: Record<string, number>;
  /** Tool id -> times shown at or above the pick without being picked. A ranking
   * input: the runtime damps the edge by min(1, (invoked + 3) / (surfaced + 3)). */
  surfaced_tools?: Record<string, number>;
  /** Skill id -> the same, for the skill arm. */
  surfaced_skills?: Record<string, number>;
  [extra: string]: unknown;
}

/** The whole graph as serialised by the runtime. */
export interface IntentGraphDocument {
  /** Schema version. Only `1` is known; an unknown version must be rejected, never degraded. */
  v: 1;
  /** Epoch millis of the newest event folded in. Provenance only. */
  built_from_ts: number;
  /** Monotonic write counter, bumped once per mutation. Absent means 0. */
  rev?: number;
  /** Embedding-model fingerprint when centroids exist; absent for lexical graphs. */
  model?: string;
  /** The clustering policy the clusters were drawn under; absent means the defaults. */
  cluster_policy?: { similarity?: number; coverage?: number; [extra: string]: unknown };
  /** The clusters. Order is not significant. */
  intents: IntentGraphIntent[];
  [extra: string]: unknown;
}

/** Who wrote a stored graph: a runtime pushing its own, or a Cloud-side builder. */
export type IntentGraphProducer = "runtime" | "cloud";

/**
 * The reserved `graph_key` the Cloud-side builder writes under (producer
 * `"cloud"`). A runtime can never push under this key, so the two producers
 * never share a row.
 */
export const CLOUD_INTENT_GRAPH_KEY = "cloud";

/**
 * Cloud also keeps one graph per runtime source, learned from that source's
 * events alone, under `cloud/<source_id>`. The merged graph is the one served
 * by default; a runtime may ask for its own by key. Every key under this
 * prefix is Cloud's to write, so a runtime cannot push one.
 */
export const CLOUD_SOURCE_GRAPH_PREFIX = "cloud/";

export function cloudSourceGraphKey(sourceId: string): string {
  return `${CLOUD_SOURCE_GRAPH_PREFIX}${sourceId}`;
}

/** Whether Cloud owns this key: the merged cloud graph or a per-source one. */
export function isCloudGraphKey(key: string): boolean {
  return key === CLOUD_INTENT_GRAPH_KEY || key.startsWith(CLOUD_SOURCE_GRAPH_PREFIX);
}

/** The runtime source a per-source cloud key was learned from, or null for any other key. */
export function cloudGraphSource(key: string): string | null {
  return key.startsWith(CLOUD_SOURCE_GRAPH_PREFIX)
    ? key.slice(CLOUD_SOURCE_GRAPH_PREFIX.length)
    : null;
}

/** Edge kind. A cluster carries two separate maps because ranking treats them as separate arms. */
export type IntentGraphEdgeKind = "tool" | "skill";

/** Body cap for `PUT /api/v1/intent-graph`, matching the catalog snapshot route. */
export const MAX_INTENT_GRAPH_BYTES = 4_000_000;
/** Cluster cap per graph. The runtime evicts stale clusters, so a healthy graph is far below this. */
export const MAX_INTENT_GRAPH_CLUSTERS = 5_000;
/** `source_id` cap, matching the catalog snapshot route. */
export const MAX_INTENT_GRAPH_SOURCE_ID_LENGTH = 512;

export type IntentGraphValidation =
  | { ok: true; graph: IntentGraphDocument }
  | { ok: false; details: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Structural validation against the protocol/v1 intent-graph schema and its
 * conformance vectors (`lib/catalog/__fixtures__/catalog-v2-vectors.json`,
 * key `graph`). Collects every violation rather than stopping at the first.
 *
 * Messages name a path and a rule, never a value: members are raw user text
 * and a rejected body must not leak into logs or error responses. On success
 * the same object reference is returned, so unknown fields are preserved.
 */
export function validateIntentGraph(input: unknown): IntentGraphValidation {
  const details: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, details: ["graph: must be an object"] };
  }
  if (input.v !== 1) {
    details.push("graph.v: unsupported schema version (only 1 is known)");
  }
  if (!isNonNegativeInteger(input.built_from_ts)) {
    details.push("graph.built_from_ts: must be a non-negative integer");
  }
  if (input.rev !== undefined && !isNonNegativeInteger(input.rev)) {
    details.push("graph.rev: must be a non-negative integer when present");
  }
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length === 0)) {
    details.push("graph.model: must be a non-empty string when present");
  }
  if (!Array.isArray(input.intents)) {
    details.push("graph.intents: must be an array");
    return { ok: false, details };
  }
  if (input.intents.length > MAX_INTENT_GRAPH_CLUSTERS) {
    details.push(`graph.intents: exceeds ${MAX_INTENT_GRAPH_CLUSTERS} clusters`);
  }
  const seenIds = new Set<string>();
  input.intents.forEach((intent, i) => {
    const at = `graph.intents[${i}]`;
    if (!isRecord(intent)) {
      details.push(`${at}: must be an object`);
      return;
    }
    if (typeof intent.id !== "string" || intent.id.length === 0) {
      details.push(`${at}.id: must be a non-empty string`);
    } else if (seenIds.has(intent.id)) {
      details.push(`${at}.id: duplicates another cluster id`);
    } else {
      seenIds.add(intent.id);
    }
    if (typeof intent.label !== "string") details.push(`${at}.label: must be a string`);
    if (!isStringArray(intent.terms)) details.push(`${at}.terms: must be an array of strings`);
    if (!isStringArray(intent.members) || intent.members.length === 0) {
      details.push(`${at}.members: must be a non-empty array of strings`);
    }
    if (intent.centroid !== undefined) {
      const c = intent.centroid;
      if (
        !Array.isArray(c) ||
        c.length === 0 ||
        !c.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        details.push(`${at}.centroid: must be a non-empty array of finite numbers when present`);
      }
    }
    const support = intent.support;
    if (!isNonNegativeInteger(support) || support < 1) {
      details.push(`${at}.support: must be an integer >= 1`);
    }
    if (intent.seeded_support !== undefined) {
      if (!isNonNegativeInteger(intent.seeded_support)) {
        details.push(`${at}.seeded_support: must be a non-negative integer when present`);
      } else if (isNonNegativeInteger(support) && intent.seeded_support > support) {
        details.push(`${at}.seeded_support: must not exceed support`);
      }
    }
    if (intent.last_ts !== undefined && !isNonNegativeInteger(intent.last_ts)) {
      details.push(`${at}.last_ts: must be a non-negative integer when present`);
    }
    for (const kind of ["tools", "skills"] as const) {
      const edges = intent[kind];
      if (!isRecord(edges)) {
        details.push(`${at}.${kind}: must be an object of capability id to weight`);
        continue;
      }
      for (const [id, weight] of Object.entries(edges)) {
        if (id.length === 0) details.push(`${at}.${kind}: capability id must be non-empty`);
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
          details.push(`${at}.${kind}: weight must be a finite number > 0`);
          break;
        }
      }
    }
    for (const kind of ["surfaced_tools", "surfaced_skills"] as const) {
      const counts = intent[kind];
      if (counts === undefined) continue;
      if (!isRecord(counts)) {
        details.push(`${at}.${kind}: must be an object of capability id to count when present`);
        continue;
      }
      for (const [id, count] of Object.entries(counts)) {
        if (id.length === 0) details.push(`${at}.${kind}: capability id must be non-empty`);
        if (!isNonNegativeInteger(count)) {
          details.push(`${at}.${kind}: count must be a non-negative integer`);
          break;
        }
      }
    }
  });
  return details.length === 0
    ? { ok: true, graph: input as unknown as IntentGraphDocument }
    : { ok: false, details };
}

/**
 * sha256 over the canonical document with the top-level `rev` removed. `rev`
 * moves on every mutation, but two saves with identical content must hash the
 * same so a resave is a no-op; everything else, including unknown fields,
 * stays in the hash so a rebuilt graph is a real change.
 */
export function intentGraphContentHash(graph: IntentGraphDocument): string {
  const { rev: _rev, ...rest } = graph;
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
}

/** Strong ETag for a stored graph. */
export function intentGraphEtag(contentHash: string): string {
  return `"${contentHash}"`;
}

/**
 * The document without the clusters whose last observation is older than
 * `cutoffMs`. A cluster's `members` are raw asks (on the OTLP lane, the user's
 * message to the model), and the wire form dates the cluster, not each
 * member, so retention is enforced per cluster: one that has gone unobserved
 * past event retention leaves the graph whole, members, label, terms and
 * edges. A cluster without `last_ts` (not produced by the learner) is kept.
 * The caller writes the result through `putIntentGraph`, which assigns the
 * next rev and rebuilds the projection.
 */
export function expireIntentGraphClusters(
  graph: IntentGraphDocument,
  cutoffMs: number,
): { graph: IntentGraphDocument; expired: number } {
  const intents = graph.intents.filter(
    (intent) => intent.last_ts === undefined || intent.last_ts >= cutoffMs,
  );
  const expired = graph.intents.length - intents.length;
  return expired === 0 ? { graph, expired } : { graph: { ...graph, intents }, expired };
}

export type IntentGraphPutBody =
  | { ok: true; sourceId: string; graph: IntentGraphDocument }
  | { ok: false; details: string[] };

/** Parse and validate the `PUT /api/v1/intent-graph` body `{ source_id, graph }`. */
export function parseIntentGraphPutBody(input: unknown): IntentGraphPutBody {
  if (!isRecord(input)) return { ok: false, details: ["body: must be an object"] };
  const details: string[] = [];
  const rawSource = input.source_id;
  const sourceId = typeof rawSource === "string" ? rawSource.trim() : "";
  if (sourceId.length === 0) details.push("source_id: must be a non-empty string");
  else if (sourceId.length > MAX_INTENT_GRAPH_SOURCE_ID_LENGTH) {
    details.push(`source_id: exceeds ${MAX_INTENT_GRAPH_SOURCE_ID_LENGTH} characters`);
  }
  const graph = validateIntentGraph(input.graph);
  if (!graph.ok) details.push(...graph.details);
  if (details.length > 0 || !graph.ok) return { ok: false, details };
  return { ok: true, sourceId, graph: graph.graph };
}
