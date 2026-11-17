import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import type { TraceQueriesDb } from "@/lib/synthesis/traces/queries";
import { listRunAsks, listRunTools } from "@/lib/synthesis/traces/run-details";
import type { SessionsFilter } from "./view";

/**
 * The Sessions list (`cloud-traces-sessions`): one row per session, newest
 * activity first, paged by a cursor. There is no timeframe: a page reads at
 * most `limit + 1` rows from each of two index walks, however old the project.
 *
 * A session is its closed turns (`trace_turns`, as the session replay shows
 * them); its activity is its latest turn's end. A run whose trace sits in no
 * closed turn is its own row, at its top-level span's start: a run with no
 * session, or one whose turn is still open (it joins its session when the turn
 * closes). A runtime-lane turn and an OTLP run of the same trace are not
 * joined here: the step → event link has no index.
 *
 * Failed: a turn with an error step, or a span that ended in an error (a
 * failed tool call is one) in any of the session's runs.
 *
 * PRIVACY: the ask is read only from captured span attributes (`listRunAsks`);
 * every other read is ids, counts, times and topic names.
 */

export interface SessionRow {
  /** The session id, or the trace id of a run with no session. */
  id: string;
  kind: "session" | "run";
  sessionId: string | null;
  /** The session's runs in turn order (OTLP turns only), or the run's own trace. */
  traceIds: string[];
  /** The first run's ask; null when text is off or the first turn has no run. */
  ask: string | null;
  /** The first turn's intent (topic) name. */
  intent: string | null;
  turns: number;
  startedAt: string;
  lastActivityAt: string;
  durationMs: number;
  failed: boolean;
  tools: string[];
  costUsd: number;
  tokens: number;
  experiment: { name: string; arm: string | null } | null;
  href: string;
}

export interface SessionsPage {
  items: SessionRow[];
  nextCursor: string | null;
}

export interface ListSessionsOptions {
  filter: SessionsFilter;
  cursor?: string | null;
  limit?: number;
}

/** Where the next page starts: the last row's activity (UTC, microseconds) and id. */
export interface SessionsCursor {
  at: string;
  id: string;
}

/** The trace reads plus raw SQL, for the two page walks. */
export type SessionsDb = TraceQueriesDb & Pick<ReturnType<typeof getDb>, "execute">;

export const SESSIONS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Turns read per session for its runs; the replay shows at most as many. */
const MAX_TURNS_PER_SESSION = 200;
const OTLP_KEY = "otlp:";
/** Fixed-width UTC with microseconds: sorts as text, and reads back as a timestamptz. */
const AT_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;
const logger = getLogger("traces-sessions");

/** One page of the list. Rows from both walks merge on (activity, id), newest first. */
export async function listSessions(
  projectId: string,
  options: ListSessionsOptions,
  db: SessionsDb = getDb(),
): Promise<SessionsPage> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? SESSIONS_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const cursor = decodeSessionsCursor(options.cursor);
  const sessions = rowsOf<PageHead>(
    await db.execute(sessionPageQuery(projectId, options.filter, cursor, limit + 1)),
  );
  const runs = rowsOf<PageHead>(
    await db.execute(runPageQuery(projectId, options.filter, cursor, limit + 1)),
  );
  const merged = [
    ...sessions.map((row) => ({ ...row, kind: "session" as const })),
    ...runs.map((row) => ({ ...row, kind: "run" as const })),
  ].sort(newestFirst);
  const heads = merged.slice(0, limit);
  const last = heads.at(-1);
  const nextCursor =
    merged.length > limit && last ? encodeSessionsCursor({ at: last.at, id: last.id }) : null;
  const items = await loadRows(projectId, heads, db);
  logger.info(
    {
      project_id: projectId,
      filter: options.filter,
      rows: items.length,
      more: nextCursor !== null,
    },
    "traces_sessions_page_loaded",
  );
  return { items, nextCursor };
}

/** `listSessions` under the read statement timeout, on its own connection. */
export function loadSessionsPage(
  projectId: string,
  options: ListSessionsOptions,
  timeoutMs?: number | null,
): Promise<SessionsPage> {
  return withStatementTimeout((db) => listSessions(projectId, options, db), {
    operation: "traces_sessions_page",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Session heads past the cursor: each session's latest closed turn, walked
 * backwards on `trace_turns_closed_ended_idx` under the LIMIT.
 */
export function sessionPageQuery(
  projectId: string,
  filter: SessionsFilter,
  cursor: SessionsCursor | null,
  limit: number,
): SQL {
  const failed = sql`exists (
    select 1 from trace_turns f
    where f.project_id = t.project_id and f.session_id = t.session_id and f.status = 'closed'
      and (f.error_count > 0 or (f.turn_key like 'otlp:%' and exists (
        select 1 from otel_spans s where s.project_id = f.project_id and s.trace_id = substr(f.turn_key, ${OTLP_KEY.length + 1}) and s.status_code = 2
      )))
  )`;
  return sql`
    select t.session_id as id, to_char(t.ended_at at time zone 'UTC', ${AT_FORMAT}) as at, ${failed} as failed
    from trace_turns t
    where t.project_id = ${projectId} and t.status = 'closed'
      ${cursor ? sql`and t.ended_at <= ${cursor.at}::timestamptz and (t.ended_at < ${cursor.at}::timestamptz or t.session_id collate "C" < ${cursor.id})` : sql``}
      and not exists (
        select 1 from trace_turns n
        where n.project_id = t.project_id and n.session_id = t.session_id and n.status = 'closed' and (n.ended_at, n.id) > (t.ended_at, t.id)
      )
      ${filter === "failed" ? sql`and ${failed}` : sql``}
    order by t.ended_at desc, t.session_id collate "C" desc
    limit ${limit}`;
}

/**
 * Runs in no closed turn, past the cursor: each trace's earliest top-level
 * span, walked backwards on `otel_spans_project_roots_started_idx` under the
 * LIMIT. A trace with no top-level span is not listed.
 */
export function runPageQuery(
  projectId: string,
  filter: SessionsFilter,
  cursor: SessionsCursor | null,
  limit: number,
): SQL {
  const failed = sql`exists (select 1 from otel_spans s where s.project_id = r.project_id and s.trace_id = r.trace_id and s.status_code = 2)`;
  return sql`
    select r.trace_id as id, to_char(r.started_at at time zone 'UTC', ${AT_FORMAT}) as at, ${failed} as failed
    from otel_spans r
    where r.project_id = ${projectId} and r.parent_span_id is null
      ${cursor ? sql`and r.started_at <= ${cursor.at}::timestamptz and (r.started_at < ${cursor.at}::timestamptz or r.trace_id collate "C" < ${cursor.id})` : sql``}
      and not exists (
        select 1 from otel_spans e
        where e.project_id = r.project_id and e.trace_id = r.trace_id and e.parent_span_id is null and (e.started_at, e.span_id) < (r.started_at, r.span_id)
      )
      and not exists (
        select 1 from trace_turns k where k.project_id = r.project_id and k.turn_key = ${OTLP_KEY} || r.trace_id and k.status = 'closed'
      )
      ${filter === "failed" ? sql`and ${failed}` : sql``}
    order by r.started_at desc, r.trace_id collate "C" desc
    limit ${limit}`;
}

export function encodeSessionsCursor(cursor: SessionsCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

/** The cursor, or null (the first page) when it is missing or malformed. */
export function decodeSessionsCursor(value: string | null | undefined): SessionsCursor | null {
  if (!value) return null;
  const text = Buffer.from(value, "base64url").toString("utf8");
  const split = text.indexOf("|");
  if (split < 0) return null;
  const at = text.slice(0, split);
  const id = text.slice(split + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) || !id) return null;
  return { at, id };
}

interface PageHead {
  id: string;
  at: string;
  failed: boolean;
}

type Head = PageHead & { kind: "session" | "run" };

/** Activity then id, both descending, as the two queries order them (`collate "C"` is code-unit order). */
function newestFirst(a: Head, b: Head): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The page's rows: turns and runs, then asks, intents and per-run numbers, one read each. */
async function loadRows(
  projectId: string,
  heads: readonly Head[],
  db: TraceQueriesDb,
): Promise<SessionRow[]> {
  if (heads.length === 0) return [];
  const sessionIds = heads.filter((head) => head.kind === "session").map((head) => head.id);
  const runIds = heads.filter((head) => head.kind === "run").map((head) => head.id);
  const turns = await loadSessionTurns(projectId, sessionIds, db);
  const roots = await loadRunRoots(projectId, runIds, db);
  const intents = await loadIntents(
    projectId,
    [...turns.values()].map((list) => list[0]?.id).filter((id): id is string => !!id),
    db,
  );

  const traceIdsOf = (head: Head) =>
    head.kind === "run"
      ? [head.id]
      : (turns.get(head.id) ?? []).flatMap((turn) => (turn.traceId ? [turn.traceId] : []));
  const allTraceIds = [...new Set(heads.flatMap(traceIdsOf))];
  const firstTraceIds = heads
    .map((head) => (head.kind === "run" ? head.id : turns.get(head.id)?.[0]?.traceId))
    .filter((id): id is string => !!id);
  const asks = await listRunAsks(projectId, firstTraceIds, db);
  const tools = await listRunTools(projectId, allTraceIds, db);
  const totals = await loadRunTotals(projectId, allTraceIds, db);

  const project = `/project/${encodeURIComponent(projectId)}`;
  return heads.map((head) => {
    const traceIds = traceIdsOf(head);
    const sum = traceIds.map((id) => totals.get(id)).filter((total): total is RunTotals => !!total);
    const base = {
      id: head.id,
      traceIds,
      failed: head.failed === true,
      tools: [...new Set(traceIds.flatMap((id) => tools.get(id) ?? []))],
      costUsd: sum.reduce((total, run) => total + run.costUsd, 0),
      tokens: sum.reduce((total, run) => total + run.tokens, 0),
      experiment: sum.find((run) => run.experiment)?.experiment ?? null,
    };
    if (head.kind === "run") {
      const root = roots.get(head.id);
      const startedAt = root?.startedAt ?? new Date(head.at);
      const endedAt = root?.endedAt ?? startedAt;
      return {
        ...base,
        kind: "run",
        sessionId: null,
        ask: asks.get(head.id)?.prompt ?? null,
        intent: null,
        turns: 1,
        startedAt: startedAt.toISOString(),
        lastActivityAt: startedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        href: `${project}/traces/${encodeURIComponent(head.id)}`,
      };
    }
    const list = turns.get(head.id) ?? [];
    const first = list[0];
    const startedAt = first?.startedAt ?? new Date(head.at);
    const lastAt = list.reduce(
      (latest, turn) => (turn.endedAt > latest ? turn.endedAt : latest),
      startedAt,
    );
    return {
      ...base,
      kind: "session",
      sessionId: head.id,
      ask: first?.traceId ? (asks.get(first.traceId)?.prompt ?? null) : null,
      intent: first ? (intents.get(first.id) ?? null) : null,
      turns: list.length,
      startedAt: startedAt.toISOString(),
      lastActivityAt: lastAt.toISOString(),
      durationMs: Math.max(0, lastAt.getTime() - startedAt.getTime()),
      href: `${project}/sessions/${encodeURIComponent(head.id)}`,
    };
  });
}

interface SessionTurn {
  id: string;
  traceId: string | null;
  startedAt: Date;
  endedAt: Date;
}

/** Each session's closed turns in order, on the `(project, session, status)` index. */
async function loadSessionTurns(
  projectId: string,
  sessionIds: readonly string[],
  db: TraceQueriesDb,
): Promise<Map<string, SessionTurn[]>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: traceTurns.id,
      sessionId: traceTurns.sessionId,
      turnKey: traceTurns.turnKey,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        inArray(traceTurns.sessionId, [...sessionIds]),
        eq(traceTurns.status, "closed"),
      ),
    )
    .orderBy(traceTurns.sessionId, traceTurns.startedAt, traceTurns.id);
  const out = new Map<string, SessionTurn[]>();
  for (const row of rows) {
    const list = out.get(row.sessionId) ?? [];
    if (list.length >= MAX_TURNS_PER_SESSION) continue;
    list.push({
      id: row.id,
      traceId: row.turnKey.startsWith(OTLP_KEY) ? row.turnKey.slice(OTLP_KEY.length) : null,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    });
    out.set(row.sessionId, list);
  }
  return out;
}

/** Each run's earliest top-level span: its start and end. */
async function loadRunRoots(
  projectId: string,
  traceIds: readonly string[],
  db: TraceQueriesDb,
): Promise<Map<string, { startedAt: Date; endedAt: Date }>> {
  if (traceIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([otelSpans.traceId], {
      traceId: otelSpans.traceId,
      startedAt: otelSpans.startedAt,
      endedAt: otelSpans.endedAt,
    })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        inArray(otelSpans.traceId, [...traceIds]),
        sql`${otelSpans.parentSpanId} is null`,
      ),
    )
    .orderBy(otelSpans.traceId, otelSpans.startedAt, otelSpans.spanId);
  return new Map(
    rows.map((row) => [row.traceId, { startedAt: row.startedAt, endedAt: row.endedAt }]),
  );
}

/** The intent name of each of these turns, when one was assigned. */
async function loadIntents(
  projectId: string,
  turnIds: readonly string[],
  db: TraceQueriesDb,
): Promise<Map<string, string>> {
  if (turnIds.length === 0) return new Map();
  const rows = await db
    .select({ turnId: traceTurnTopics.turnId, name: traceTopics.name })
    .from(traceTurnTopics)
    .innerJoin(
      traceTopics,
      and(
        eq(traceTopics.projectId, traceTurnTopics.projectId),
        eq(traceTopics.topicId, traceTurnTopics.topicId),
      ),
    )
    .where(
      and(
        eq(traceTurnTopics.projectId, projectId),
        inArray(traceTurnTopics.turnId, [...turnIds]),
        eq(traceTurnTopics.verdict, "topic"),
      ),
    );
  return new Map(rows.map((row) => [row.turnId, row.name]));
}

interface RunTotals {
  costUsd: number;
  tokens: number;
  experiment: { name: string; arm: string | null } | null;
}

/** Cost, tokens and the search experiment of each run, on the `(project, trace)` index. */
async function loadRunTotals(
  projectId: string,
  traceIds: readonly string[],
  db: TraceQueriesDb,
): Promise<Map<string, RunTotals>> {
  if (traceIds.length === 0) return new Map();
  const rows = await db
    .select({
      traceId: otelSpans.traceId,
      costUsd: sql<string | null>`sum(${otelSpans.costUsd})`,
      tokens: sql<
        string | null
      >`sum(coalesce(${otelSpans.inputTokens}, 0) + coalesce(${otelSpans.outputTokens}, 0))`,
      experimentName: sql<string | null>`min(${otelSpans.experimentName})`,
      experimentArm: sql<string | null>`min(${otelSpans.experimentArm})`,
    })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), inArray(otelSpans.traceId, [...traceIds])))
    .groupBy(otelSpans.traceId);
  return new Map(
    rows.map((row) => [
      row.traceId,
      {
        costUsd: Number(row.costUsd ?? 0),
        tokens: Number(row.tokens ?? 0),
        experiment: row.experimentName
          ? { name: row.experimentName, arm: row.experimentArm }
          : null,
      },
    ]),
  );
}

function rowsOf<Row>(result: unknown): Row[] {
  return ((result as { rows?: Row[] }).rows ?? (result as Row[])) as Row[];
}
