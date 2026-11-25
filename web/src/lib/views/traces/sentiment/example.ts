import { and, asc, eq, gt, sql } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { loadErrorMessages } from "@/lib/readings/trace-signals/outcomes/run-queries";
import {
  loadNextScopeReplies,
  loadOtlpSessionPrompts,
} from "@/lib/readings/trace-signals/outcomes/text-queries";
import { replyTextOf } from "@/lib/readings/trace-signals/self-corrections/replies";
import {
  loadReplyRows,
  loadTurnTraces,
} from "@/lib/readings/trace-signals/self-corrections/run-queries";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * One turn read on demand for the Traces turn view (`loadTurnConversation`):
 * the person's request, what the agent ran with each call's outcome and
 * error, the agent's reply and the person's next message.
 *
 * Nothing here is stored. The outcome rows hold closed values and ids; the
 * words are read from the turn's own events at the moment the turn is shown,
 * cut to a bounded length, and never logged. A project that sends no messages
 * gets the steps and the errors only. Captured events are pruned after 30
 * days, so an older turn may have its steps and no words.
 */

/** Steps listed at most; a turn with more says how many were left out. */
export const EXAMPLE_MAX_STEPS = 40;
/** A message or a reply is cut here. */
export const EXAMPLE_MAX_TEXT_CHARS = 1_200;
/** An error message is cut here. Real ones are one short sentence. */
export const EXAMPLE_MAX_ERROR_CHARS = 300;

const DAY_MS = 86_400_000;
const DECLARED = "declared:";

export interface ExampleStep {
  ordinal: number;
  kind: "search" | "invoke";
  /** A node id (a skill as `skill:<id>`); null for a search. */
  tool: string | null;
  outcome: "ok" | "error" | "unknown" | null;
  /** A search's hit count. */
  hits: number | null;
  /** A failed call's error message, when it is still kept. */
  error: string | null;
}

export interface TurnExample {
  turnId: string;
  sessionId: string;
  startedAt: string;
  /** The person's request, the reply or the next message could be read. */
  text: boolean;
  request: string | null;
  steps: ExampleStep[];
  moreSteps: number;
  reply: string | null;
  /** The person's next message in the session. */
  next: string | null;
}

function cut(text: string | null | undefined, max: number): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

const nodeOf = (targetType: string | null, targetId: string | null): string | null =>
  targetId === null ? null : targetType === "skill" ? `skill:${targetId}` : targetId;

/** The person's next message after a declared turn: the session's next turn scope that sent one, within a day. */
async function nextMessage(
  db: BoundReadDb,
  projectId: string,
  turn: { sessionId: string; turnKey: string; startedAt: Date },
): Promise<string | null> {
  const own = turn.turnKey.slice(DECLARED.length);
  const result = await db.execute<{ message: string | null }>(sql`
    select e.payload ->> 'user_message' as message
      from trace_events e
     where e.project_id = ${projectId}::uuid and e.type = 'turn_start' and e.session_id = ${turn.sessionId}
       and coalesce(e.occurred_at, e.received_at) > ${turn.startedAt.toISOString()}::timestamptz
       and coalesce(e.occurred_at, e.received_at) < ${new Date(turn.startedAt.getTime() + DAY_MS).toISOString()}::timestamptz
       and coalesce(e.turn_id, e.payload ->> 'turn_id') is distinct from ${own}
       and coalesce(e.payload ->> 'user_message', '') <> ''
     order by coalesce(e.occurred_at, e.received_at)
     limit 1
  `);
  return result.rows[0]?.message ?? null;
}

/**
 * An OTel turn's next message: the person's next prompt in the session, as
 * the reading pairs them. It may have started no turn (no call after it), so
 * the next turn's request is not it. Null when the turn's own prompt is not
 * among them.
 */
async function nextPrompt(
  db: BoundReadDb,
  projectId: string,
  turn: { sessionId: string; turnKey: string; startedAt: Date },
): Promise<string | null> {
  const prompts = await loadOtlpSessionPrompts(
    projectId,
    [turn.sessionId],
    { from: turn.startedAt, to: new Date(turn.startedAt.getTime() + DAY_MS) },
    db,
  );
  const own = prompts.findIndex((prompt) => prompt.turnId === turn.turnKey);
  return own < 0 ? null : (prompts[own + 1]?.text ?? null);
}

/** The person's next message after any other turn: the ask of the session's next turn, when it is the person's own words. */
async function nextTurnAsk(
  db: BoundReadDb,
  projectId: string,
  turn: { id: string; sessionId: string; startedAt: Date },
): Promise<string | null> {
  const [next] = await db
    .select({ id: traceTurns.id })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.sessionId, turn.sessionId),
        sql`${traceTurns.startedAt} > ${turn.startedAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(traceTurns.startedAt))
    .limit(1);
  if (!next) return null;
  const ask = (await loadAskSourcesByTurn(projectId, [next.id], db)).get(next.id);
  return ask && ask.source !== "search" ? ask.text : null;
}

/** The agent's last reply in a turn, from its stored model calls; null when none was kept. */
async function replyOfTurn(
  db: BoundReadDb,
  projectId: string,
  turn: { id: string; turnKey: string; lane: string | null },
): Promise<string | null> {
  const lane = turn.lane === "otlp" ? "otlp" : "runtime";
  const traces = (
    await loadTurnTraces(projectId, [{ id: turn.id, turnKey: turn.turnKey, lane }], db)
  ).get(turn.id);
  const replies = traces && traces.size > 0 ? await loadReplyRows(projectId, [...traces], db) : [];
  const last = replies.reduce<(typeof replies)[number] | null>(
    (latest, row) => (!latest || row.at > latest.at ? row : latest),
    null,
  );
  return last ? replyTextOf(last.reply as Parameters<typeof replyTextOf>[0]) : null;
}

/** A turn as a conversation: what was asked, what the agent replied, and what came after. */
export interface TurnConversation {
  request: string | null;
  reply: string | null;
  /**
   * What came after: the person's next message; when the project sends no
   * messages, the agent's reply in the session's next turn (how it took the
   * person's reaction is all there is to read).
   */
  next: { from: "person" | "agent"; text: string } | null;
}

/**
 * The words around a turn, for the Traces turn view (behind
 * `sentimentAnalysis`): read on demand like an example, cut to
 * `EXAMPLE_MAX_TEXT_CHARS`, never stored or logged. Null for an unknown turn.
 */
export async function loadTurnConversation(
  db: BoundReadDb,
  projectId: string,
  turnId: string,
): Promise<TurnConversation | null> {
  const example = await loadTurnExample(db, projectId, turnId);
  if (!example) return null;
  if (example.next)
    return {
      request: example.request,
      reply: example.reply,
      next: { from: "person", text: example.next },
    };
  // The agent's reply in the scope after this turn's (one with no call, a "thanks", has no turn of its own), as the reading pairs them.
  const steps = await db
    .select({ eventId: traceTurnSteps.traceEventId })
    .from(traceTurnSteps)
    .where(and(eq(traceTurnSteps.projectId, projectId), eq(traceTurnSteps.turnId, turnId)));
  const scoped = (
    await loadNextScopeReplies(
      projectId,
      [[turnId, example.sessionId, steps.map((step) => step.eventId)]],
      db,
    )
  ).get(turnId);
  if (scoped)
    return {
      request: example.request,
      reply: example.reply,
      next: { from: "agent", text: cut(scoped, EXAMPLE_MAX_TEXT_CHARS)! },
    };
  // A session that reports no scopes: the reply of its next turn.
  const [following] = await db
    .select({ id: traceTurns.id, turnKey: traceTurns.turnKey, lane: traceTurns.lane })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.sessionId, example.sessionId),
        gt(traceTurns.startedAt, new Date(example.startedAt)),
      ),
    )
    .orderBy(asc(traceTurns.startedAt))
    .limit(1);
  const nextReply = following
    ? cut(await replyOfTurn(db, projectId, following), EXAMPLE_MAX_TEXT_CHARS)
    : null;
  return {
    request: example.request,
    reply: example.reply,
    next: nextReply ? { from: "agent", text: nextReply } : null,
  };
}

/** One turn's example, only within the project; null when the turn is not the project's. */
export async function loadTurnExample(
  db: BoundReadDb,
  projectId: string,
  turnId: string,
): Promise<TurnExample | null> {
  const [turn] = await db
    .select({
      id: traceTurns.id,
      sessionId: traceTurns.sessionId,
      turnKey: traceTurns.turnKey,
      lane: traceTurns.lane,
      startedAt: traceTurns.startedAt,
    })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, turnId)))
    .limit(1);
  if (!turn) return null;

  const stepRows = await db
    .select({
      ordinal: traceTurnSteps.ordinal,
      kind: traceTurnSteps.kind,
      targetType: traceTurnSteps.targetType,
      targetId: traceTurnSteps.targetId,
      outcome: traceTurnSteps.outcome,
      hitCount: traceTurnSteps.hitCount,
      traceEventId: traceTurnSteps.traceEventId,
      endTraceEventId: traceTurnSteps.endTraceEventId,
    })
    .from(traceTurnSteps)
    .where(and(eq(traceTurnSteps.projectId, projectId), eq(traceTurnSteps.turnId, turn.id)))
    .orderBy(asc(traceTurnSteps.ordinal))
    .limit(EXAMPLE_MAX_STEPS + 1);
  const [counted] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(traceTurnSteps)
    .where(and(eq(traceTurnSteps.projectId, projectId), eq(traceTurnSteps.turnId, turn.id)));
  const listed = stepRows.slice(0, EXAMPLE_MAX_STEPS);
  const errorEventOf = (step: (typeof listed)[number]) => step.endTraceEventId ?? step.traceEventId;
  const errors = await loadErrorMessages(
    projectId,
    listed.filter((step) => step.outcome === "error").map(errorEventOf),
    db,
  );

  // One after another: the caller hands over one connection (a bounded read's transaction).
  const ask = (await loadAskSourcesByTurn(projectId, [turn.id], db)).get(turn.id);
  const request = ask && ask.source !== "search" ? ask.text : null;
  const reply = await replyOfTurn(db, projectId, turn);
  const next = turn.turnKey.startsWith(DECLARED)
    ? await nextMessage(db, projectId, turn)
    : ((await nextPrompt(db, projectId, turn)) ?? (await nextTurnAsk(db, projectId, turn)));

  const example: TurnExample = {
    turnId: turn.id,
    sessionId: turn.sessionId,
    startedAt: turn.startedAt.toISOString(),
    text: false,
    request: cut(request, EXAMPLE_MAX_TEXT_CHARS),
    steps: listed.map((step) => ({
      ordinal: step.ordinal,
      kind: step.kind === "search" ? "search" : "invoke",
      tool: step.kind === "search" ? null : nodeOf(step.targetType, step.targetId),
      outcome:
        step.outcome === "ok" || step.outcome === "error" || step.outcome === "unknown"
          ? step.outcome
          : null,
      hits: step.kind === "search" ? step.hitCount : null,
      error:
        step.outcome === "error"
          ? cut(errors.get(errorEventOf(step)), EXAMPLE_MAX_ERROR_CHARS)
          : null,
    })),
    moreSteps: Math.max(0, (counted?.n ?? listed.length) - listed.length),
    reply: cut(reply, EXAMPLE_MAX_TEXT_CHARS),
    next: cut(next, EXAMPLE_MAX_TEXT_CHARS),
  };
  return {
    ...example,
    text: example.request !== null || example.reply !== null || example.next !== null,
  };
}
