import { type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { listRunAsks } from "@/lib/synthesis/traces/run-details";
import { type TraceFilter, traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";
import {
  decodeSessionsCursor,
  encodeSessionsCursor,
  type SessionsCursor,
  type SessionsDb,
} from "@/lib/synthesis/traces-sessions/sessions";
import type { SessionsFilter } from "@/lib/synthesis/traces-sessions/view";

/**
 * The Sessions tab (RC-502, decisions
 * sessions-first and session-status): one row per session id, newest last
 * update first, paged by a cursor. A turn with no session id (OTLP ingest
 * keys it by its own trace id) is not a session and is not listed.
 *
 * The page reads only the turn ledger (`trace_turns`, and `trace_turn_steps`
 * with their `trace_events` to find a runtime-lane turn's trace) and the
 * per-trace rollup (`otel_trace_summaries`): one walk for the page's heads on
 * `trace_turns_closed_ended_idx`, one aggregate for their numbers. The first
 * and last turn's text is read by trace id for the page's rows only.
 *
 * Status (derived): Active when the session has an open turn or its last
 * activity is less than 5 minutes old; else Failed when a turn failed (an
 * error step, or an error span in its trace); else Completed.
 *
 * PRIVACY: the text is read only through `listRunAsks`; every other read is ids, counts and times.
 */

export type SessionStatus = "active" | "failed" | "completed";

export interface SessionListRow {
  id: string;
  status: SessionStatus;
  /** The first turn's ask; null when text is off or the turn has no trace. */
  firstMessage: string | null;
  /** The last turn's ask; null as above. */
  lastTurn: string | null;
  turns: number;
  startedAt: string;
  lastActivityAt: string;
  durationMs: number;
  tokens: number;
  costUsd: number;
  /** The first and last turn's traces (OTLP turns only), in turn order. */
  traceIds: string[];
  href: string;
}

export interface SessionListPage {
  items: SessionListRow[];
  nextCursor: string | null;
}

export interface ListSessionListOptions {
  filter: SessionsFilter;
  cursor?: string | null;
  limit?: number;
  /** The clock the Active status reads; tests pin it. */
  now?: Date;
  /** RC-505 property filters: a session matches when any of its turns does. */
  traces?: TraceFilter;
}

export const SESSION_LIST_PAGE_SIZE = 50;
export const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_PAGE_SIZE = 100;
const OTLP_KEY = "otlp:";
const AT_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;
const logger = getLogger("traces-sessions-list");

/** One page of sessions. */
export async function listSessionList(
  projectId: string,
  options: ListSessionListOptions,
  db: SessionsDb = getDb(),
): Promise<SessionListPage> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? SESSION_LIST_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const heads = rowsOf<{ id: string; at: string }>(
    await db.execute(
      sessionListPageQuery(
        projectId,
        options.filter,
        decodeSessionsCursor(options.cursor),
        limit + 1,
        options.traces,
      ),
    ),
  );
  const page = heads.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    heads.length > limit && last ? encodeSessionsCursor({ at: last.at, id: last.id }) : null;
  const items = await loadRows(
    projectId,
    page.map((head) => head.id),
    options.now ?? new Date(),
    db,
  );
  logger.info(
    {
      project_id: projectId,
      filter: options.filter,
      rows: items.length,
      more: nextCursor !== null,
    },
    "traces_session_list_page_loaded",
  );
  return { items, nextCursor };
}

/** `listSessionList` under the read statement timeout, on its own connection. */
export function loadSessionListPage(
  projectId: string,
  options: ListSessionListOptions,
  timeoutMs?: number | null,
): Promise<SessionListPage> {
  return withStatementTimeout((db) => listSessionList(projectId, options, db), {
    operation: "traces_session_list_page",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Session heads past the cursor: each session's latest closed turn, walked
 * backwards on `trace_turns_closed_ended_idx` under the LIMIT. Turns keyed by
 * their own trace id (no session id) are skipped.
 */
export function sessionListPageQuery(
  projectId: string,
  filter: SessionsFilter,
  cursor: SessionsCursor | null,
  limit: number,
  traces?: TraceFilter,
): SQL {
  const matches = traceFilterCondition(traces);
  // Failed sessions are found once per page: closed turns with an error step,
  // plus OTLP turns whose trace has an error span (by `otlp:<trace id>` on
  // `trace_turns_project_turn_key_idx`), not one lookup per walked turn.
  const failedSessions = sql`with failed_sessions as (
      select f.session_id from trace_turns f
      where f.project_id = ${projectId} and f.status = 'closed' and f.error_count > 0
      union
      select f.session_id from otel_trace_summaries s
      join trace_turns f on f.project_id = s.project_id and f.turn_key = ${OTLP_KEY} || s.trace_id
      where s.project_id = ${projectId} and s.has_error and f.status = 'closed'
    )`;
  return sql`
    ${filter === "failed" ? failedSessions : sql``}
    ${matches ? matchedSessions(projectId, matches, filter === "failed" ? sql`,` : sql`with`) : sql``}
    select t.session_id as id, to_char(t.ended_at at time zone 'UTC', ${AT_FORMAT}) as at
    from trace_turns t
    where t.project_id = ${projectId} and t.status = 'closed' and t.turn_key <> ${OTLP_KEY} || t.session_id
      ${cursor ? sql`and t.ended_at <= ${cursor.at}::timestamptz and (t.ended_at < ${cursor.at}::timestamptz or t.session_id collate "C" < ${cursor.id})` : sql``}
      and not exists (
        select 1 from trace_turns n
        where n.project_id = t.project_id and n.session_id = t.session_id and n.status = 'closed' and (n.ended_at, n.id) > (t.ended_at, t.id)
      )
      ${filter === "failed" ? sql`and t.session_id in (select session_id from failed_sessions)` : sql``}
      ${matches ? sql`and t.session_id in (select session_id from matched_sessions)` : sql``}
    order by t.ended_at desc, t.session_id collate "C" desc
    limit ${limit}`;
}

/**
 * RC-505: the sessions with a closed turn whose trace matches the rollup
 * condition (on `s`), found once per page like `failed_sessions`. A turn's
 * trace is its `otlp:` key (on `trace_turns_project_turn_key_idx`), else a
 * trace its steps' events carry (a runtime-lane turn), as in `loadRows`.
 * `lead` opens the WITH, or continues it after `failed_sessions`.
 */
function matchedSessions(projectId: string, condition: SQL, lead: SQL): SQL {
  return sql`${lead} matched_sessions as (
      select m.session_id from otel_trace_summaries s
      join trace_turns m on m.project_id = s.project_id and m.turn_key = ${OTLP_KEY} || s.trace_id
      where s.project_id = ${projectId} and m.status = 'closed' and ${condition}
      union
      select m.session_id from trace_turns m
      join trace_turn_steps st on st.project_id = m.project_id and st.turn_id = m.id
      join trace_events e on e.project_id = st.project_id and e.id = st.trace_event_id
      join otel_trace_summaries s on s.project_id = e.project_id and s.trace_id = e.trace_id
      where m.project_id = ${projectId} and m.status = 'closed' and ${condition}
    )`;
}

/** The status of a session, per decision session-status. */
export function sessionStatus(
  { open, failed, lastActivityAt }: { open: boolean; failed: boolean; lastActivityAt: Date },
  now: Date,
): SessionStatus {
  if (open || now.getTime() - lastActivityAt.getTime() < ACTIVE_WINDOW_MS) return "active";
  return failed ? "failed" : "completed";
}

interface SessionAggregate {
  id: string;
  turns: number;
  started_at: string;
  ended_at: string;
  open: boolean;
  failed: boolean;
  tokens: string | number | null;
  cost: string | number | null;
  first_trace: string | null;
  last_trace: string | null;
}

/**
 * The page's sessions in head order: one aggregate on `(project, session,
 * status)`, then the two asks. A turn's trace is its `otlp:` key, else the
 * first trace its steps' events carry (a runtime-lane turn); each trace counts
 * once per session, however many turns of both lanes hold it.
 */
async function loadRows(
  projectId: string,
  sessionIds: readonly string[],
  now: Date,
  db: SessionsDb,
): Promise<SessionListRow[]> {
  if (sessionIds.length === 0) return [];
  const aggregates = rowsOf<SessionAggregate>(
    await db.execute(sql`
      with turns as (
        select t.session_id, t.id, t.status, t.started_at, t.ended_at, t.error_count,
          coalesce(
            case when t.turn_key like 'otlp:%' then substr(t.turn_key, ${OTLP_KEY.length + 1}) end,
            (select e.trace_id from trace_turn_steps st
              join trace_events e on e.project_id = st.project_id and e.id = st.trace_event_id
              where st.project_id = t.project_id and st.turn_id = t.id and e.trace_id is not null
              order by st.ordinal limit 1)
          ) as trace_id
        from trace_turns t
        where t.project_id = ${projectId} and t.session_id in (${sql.join(
          sessionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      ),
      traces as (
        select r.session_id, sum(s.input_tokens + s.output_tokens) as tokens, sum(s.cost_usd) as cost, bool_or(s.has_error) as has_error
        from (select distinct session_id, trace_id from turns where status = 'closed' and trace_id is not null) r
        join otel_trace_summaries s on s.project_id = ${projectId} and s.trace_id = r.trace_id
        group by r.session_id
      )
      select t.session_id as id,
        count(*) filter (where t.status = 'closed')::int as turns,
        to_char(min(t.started_at) filter (where t.status = 'closed') at time zone 'UTC', ${AT_FORMAT}) as started_at,
        to_char(max(t.ended_at) filter (where t.status = 'closed') at time zone 'UTC', ${AT_FORMAT}) as ended_at,
        bool_or(t.status = 'open') as open,
        coalesce(bool_or(t.error_count > 0) filter (where t.status = 'closed'), false) or coalesce(max(x.has_error::int) = 1, false) as failed,
        max(x.tokens) as tokens,
        max(x.cost) as cost,
        (array_agg(t.trace_id order by t.started_at, t.id) filter (where t.status = 'closed'))[1] as first_trace,
        (array_agg(t.trace_id order by t.started_at desc, t.id desc) filter (where t.status = 'closed'))[1] as last_trace
      from turns t
      left join traces x on x.session_id = t.session_id
      group by t.session_id`),
  );
  const byId = new Map(aggregates.map((row) => [row.id, row]));
  const asks = await listRunAsks(
    projectId,
    aggregates
      .flatMap((row) => [row.first_trace, row.last_trace])
      .filter((id): id is string => !!id),
    db,
  );
  const askOf = (traceId: string | null) => (traceId ? (asks.get(traceId)?.prompt ?? null) : null);

  const project = `/project/${encodeURIComponent(projectId)}`;
  return sessionIds.flatMap((id): SessionListRow[] => {
    const row = byId.get(id);
    if (!row?.started_at || !row.ended_at) return [];
    const startedAt = new Date(row.started_at);
    const lastActivityAt = new Date(row.ended_at);
    return [
      {
        id,
        status: sessionStatus(
          { open: row.open === true, failed: row.failed === true, lastActivityAt },
          now,
        ),
        firstMessage: askOf(row.first_trace),
        lastTurn: askOf(row.last_trace),
        turns: row.turns,
        startedAt: startedAt.toISOString(),
        lastActivityAt: lastActivityAt.toISOString(),
        durationMs: Math.max(0, lastActivityAt.getTime() - startedAt.getTime()),
        tokens: Number(row.tokens ?? 0),
        costUsd: Number(row.cost ?? 0),
        traceIds: [
          ...new Set([row.first_trace, row.last_trace].filter((trace): trace is string => !!trace)),
        ],
        href: `${project}/sessions/${encodeURIComponent(id)}`,
      },
    ];
  });
}

function rowsOf<Row>(result: unknown): Row[] {
  return ((result as { rows?: Row[] }).rows ?? (result as Row[])) as Row[];
}
