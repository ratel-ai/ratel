import { and, asc, eq, gt, sql } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { loadErrorMessages } from "@/lib/readings/trace-signals/outcomes/run-queries";
import { loadNextScopeReplies } from "@/lib/readings/trace-signals/outcomes/text-queries";
import { replyTextOf } from "@/lib/readings/trace-signals/self-corrections/replies";
import {
  loadReplyRows,
  loadTurnTraces,
} from "@/lib/readings/trace-signals/self-corrections/run-queries";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * One example turn of a root cause, read on demand (`GET /api/projects/
 * :projectId/sentiment/turns/:turnId/example`): the person's request, what the
 * agent ran with each call's outcome and error, the agent's reply and the
 * person's next message, for a signed-in member of the project.
 *
 * Nothing here is stored. The outcome rows hold closed values and ids; the
 * words are read from the turn's own events at the moment the Panel shows
 * them, cut to a bounded length, and never logged. A project that sends no
 * messages gets the steps and the errors only. Captured events are pruned
 * after 30 days, so an older turn may have its steps and no words.
 *
 * A route rather than a Server Action: a plain GET under `/api` is a read and
 * never re-renders the page.
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

export type ExampleResult = { ok: true; example: TurnExample } | { ok: false; message: string };

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

/** One turn's example, only within the project; null when the turn is not the project's. */
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
 * `cloud-sentiment-analysis`): read on demand like an example, cut to
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
    : await nextTurnAsk(db, projectId, turn);

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

export interface ExampleRouteDeps {
  getSession: () => Promise<{ userId: string; externalId: string } | null>;
  /** The project when the person is a member of it, with whether the page is on for its organization. */
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string; enabled: boolean } | null>;
  loadExample: (projectId: string, turnId: string) => Promise<TurnExample | null>;
  setLogContext: (context: { project_id: string; org_id: string; distinct_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND: ExampleResult = { ok: false, message: "This example isn't available." };

export async function sentimentExampleResponse(
  params: { projectId: string; turnId: string },
  deps: ExampleRouteDeps,
): Promise<Response> {
  if (!UUID.test(params.turnId)) return json(404, NOT_FOUND);
  const session = await deps.getSession();
  if (!session) return json(401, { ok: false, message: "Sign in to see this example." });
  // Not a member, or the page is off for the organization, reads exactly like a missing project: nothing to probe.
  const project = await deps.findProject(params.projectId, session.userId);
  if (!project || !project.enabled) return json(404, NOT_FOUND);
  deps.setLogContext({
    project_id: project.projectId,
    org_id: project.organizationId,
    distinct_id: session.externalId,
  });
  try {
    const example = await deps.loadExample(project.projectId, params.turnId);
    return example ? json(200, { ok: true, example }) : json(404, NOT_FOUND);
  } catch (err) {
    deps.logError({ err, project_id: project.projectId }, "sentiment example load failed");
    deps.reportException(err, `project:${project.projectId}`, {
      operation: "sentiment_example",
      project_id: project.projectId,
    });
    return json(500, { ok: false, message: "Couldn't load this example. Try again in a moment." });
  }
}

function json(status: number, body: ExampleResult): Response {
  // People's and the agent's own words, per member: never shared, never stored.
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
