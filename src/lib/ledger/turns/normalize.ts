import {
  AGENT_RUN_EVENT_TYPE,
  MAX_STEP_HIT_IDS,
  TURN_EVENT_TYPES_WITH_TYPED_STEPS,
} from "@/lib/ledger/constants";
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

const TURN_TYPES: ReadonlySet<string> = new Set(TURN_EVENT_TYPES_WITH_TYPED_STEPS);

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
  agent_run: "run",
  otlp_model_call: "step",
  otlp_step: "step",
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
  const typed = row.type === "otlp_model_call" || row.type === "otlp_step";
  if (typed && row.ingestSource !== "otlp") return null;
  const payload = row.payload ?? {};
  const stepKind =
    row.type === "otlp_model_call"
      ? "model_call"
      : payload.kind === "code" || payload.kind === "handoff"
        ? payload.kind
        : null;
  if (typed && stepKind === null) return null;
  // Only OTLP ingest writes agent runs (`otlp/derive-agent-runs.ts`).
  if (row.type === AGENT_RUN_EVENT_TYPE && row.ingestSource !== "otlp") return null;
  const type = row.type as TurnEventType;
  const role = ROLE[type];
  const listed = role === "search" ? rankedHits(type, hits) : [];
  const target =
    role === "search" ? null : role === "run" ? agentTarget(row) : invocationTarget(type, row);
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
    queryHash:
      role === "search"
        ? hashQuery(row.query, opts.salt)
        : row.type === "otlp_model_call" && typeof payload.user_message_hash === "string"
          ? hashQuery(`${payload.user_message_hash}:${payload.user_message_count ?? 0}`, opts.salt)
          : null,
    topK: role === "search" ? row.topK : null,
    hitCount: role === "search" ? (row.hitCount ?? (listed.length > 0 ? hits.length : null)) : null,
    hitIds: listed.map((h) => h.targetId),
    hitScores: listed.every((h) => h.score !== null) ? listed.map((h) => h.score as number) : null,
    targetType: typed ? null : (target?.targetType ?? null),
    targetId: typed
      ? typeof payload.signature_token === "string"
        ? payload.signature_token
        : typeof payload.name === "string"
          ? payload.name
          : null
      : (target?.targetId ?? null),
    invocationId: role === "search" ? null : row.invocationId,
    tookMs: role === "search" || role === "start" ? null : row.tookMs,
    ...(typed && stepKind ? { stepKind } : {}),
    outcome:
      role === "step"
        ? payload.status === "error" || row.failed
          ? "error"
          : "ok"
        : role === "run"
          ? row.failed
            ? "error"
            : "ok"
          : role === "end" || role === "single"
            ? outcomeOf(type)
            : null,
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

/** An agent run's target: its agent's name and no target type (RC-747); none without a name. */
function agentTarget(row: TurnEventRow): { targetType: null; targetId: string } | null {
  return row.agent ? { targetType: null, targetId: row.agent } : null;
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
