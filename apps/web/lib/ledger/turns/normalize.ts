import { MAX_STEP_HIT_IDS, TURN_EVENT_TYPES } from "@/lib/ledger/constants";
import { hashEndUser, hashQuery } from "@/lib/ledger/hash";
import type {
  EventRole,
  NormalizedEvent,
  TargetType,
  TurnEventHit,
  TurnEventRow,
  TurnEventType,
} from "@/lib/ledger/types";

/**
 * `trace_events` rows + their hits -> the text-free event stream the segmenter
 * reads. Rows of other types, and rows without a session, are dropped. Query
 * text and end-user ids leave here only as salted hashes.
 *
 * Hits are cut to `MAX_STEP_HIT_IDS` here rather than at write time so a full
 * rebuild and a re-derivation from stored steps see exactly the same lists.
 */

const TURN_TYPES: ReadonlySet<string> = new Set(TURN_EVENT_TYPES);

const ROLE: Record<TurnEventType, EventRole> = {
  search: "search",
  skill_search: "search",
  gateway_search: "search",
  invoke_start: "start",
  invoke_end: "end",
  invoke_error: "end",
  gateway_invoke: "single",
  gateway_error: "single",
  skill_invoke: "single",
};

export interface NormalizeOptions {
  salt: string;
}

export function normalizeEvents(
  rows: readonly TurnEventRow[],
  hits: ReadonlyMap<string, readonly TurnEventHit[]>,
  opts: NormalizeOptions,
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const row of rows) {
    const event = normalizeEvent(row, hits.get(row.id) ?? [], opts);
    if (event) out.push(event);
  }
  return out;
}

export function normalizeEvent(
  row: TurnEventRow,
  hits: readonly TurnEventHit[],
  opts: NormalizeOptions,
): NormalizedEvent | null {
  if (!TURN_TYPES.has(row.type) || !row.sessionId) return null;
  const type = row.type as TurnEventType;
  const role = ROLE[type];
  const listed = role === "search" ? rankedHits(type, hits) : [];
  const target = role === "search" ? null : invocationTarget(type, row);
  return {
    id: row.id,
    type,
    role,
    lane: row.ingestSource === "otlp" ? "otlp" : "runtime",
    sessionId: row.sessionId,
    sourceId: row.sourceId,
    occurredAt: (row.occurredAt ?? row.receivedAt).getTime(),
    receivedAt: row.receivedAt.getTime(),
    declaredTurnId: row.turnId ? row.turnId : null,
    traceId: row.traceId,
    endUserKey: hashEndUser(row.endUserId, opts.salt),
    queryHash: role === "search" ? hashQuery(row.query, opts.salt) : null,
    topK: role === "search" ? row.topK : null,
    hitCount: role === "search" ? (row.hitCount ?? (listed.length > 0 ? hits.length : null)) : null,
    hitIds: listed.map((h) => h.targetId),
    hitScores: listed.every((h) => h.score !== null) ? listed.map((h) => h.score as number) : null,
    targetType: target?.targetType ?? null,
    targetId: target?.targetId ?? null,
    invocationId: role === "search" ? null : row.invocationId,
    tookMs: role === "search" || role === "start" ? null : row.tookMs,
    outcome: role === "end" || role === "single" ? outcomeOf(type) : null,
    ...(row.rootTool && row.ingestSource === "otlp" ? { rootTool: true } : {}),
  };
}

/** The hits a search listed, of the catalog it searched, rank order, capped. */
function rankedHits(type: TurnEventType, hits: readonly TurnEventHit[]): TurnEventHit[] {
  const kind: TargetType | null =
    type === "search" ? "tool" : type === "skill_search" ? "skill" : null;
  if (kind === null) return [];
  return hits
    .filter((h) => h.targetType === kind)
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_STEP_HIT_IDS);
}

function invocationTarget(
  type: TurnEventType,
  row: TurnEventRow,
): { targetType: TargetType; targetId: string | null } {
  return type === "skill_invoke"
    ? { targetType: "skill", targetId: row.skillId }
    : { targetType: "tool", targetId: row.toolId };
}

function outcomeOf(type: TurnEventType): "ok" | "error" {
  return type === "invoke_error" || type === "gateway_error" ? "error" : "ok";
}
