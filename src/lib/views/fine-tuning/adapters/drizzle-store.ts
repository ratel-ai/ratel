import { type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
import type { TrainingConsent } from "../domain/consent";
import type { UseCase, UseCaseSelector } from "../domain/use-case";
import type {
  ConsentStore,
  MatchedTurn,
  ModelCallSource,
  UseCaseStore,
  UseCaseWrite,
} from "../ports/store";

/**
 * The fine-tuning store over Postgres (RC-1123). Every query filters
 * `project_id`. The partial unique index `fine_tuning_consents_active_idx`
 * keeps one active grant per project, so two admins who give it at the same
 * time make one row.
 */

type Db = Pick<ReturnType<typeof getDb>, "execute">;
type ReadDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "selectDistinct" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute"
>;

const MAX_USE_CASES = 200;
const SPAN_CHUNK = 500;
const MAX_TASK_OPTIONS = 100;

export function createDrizzleConsentStore(db: Db): ConsentStore {
  const getActiveConsent = async (projectId: string) =>
    rowsOf<ConsentRow>(await db.execute(activeConsentQuery(projectId))).map(toConsent)[0] ?? null;
  return {
    getActiveConsent,
    async giveConsent(projectId, actor, textVersion) {
      const [inserted] = rowsOf<ConsentRow>(
        await db.execute(sql`
          insert into fine_tuning_consents (project_id, given_by, text_version)
          values (${projectId}, ${actor}, ${textVersion})
          on conflict (project_id) where withdrawn_at is null do nothing
          returning ${CONSENT_COLUMNS}
        `),
      );
      if (inserted) return { consent: toConsent(inserted), created: true };
      const active = await getActiveConsent(projectId);
      if (!active) throw new Error("training consent conflict without an active grant");
      return { consent: active, created: false };
    },
    async withdrawConsent(projectId, actor) {
      const [row] = rowsOf<ConsentRow>(
        await db.execute(sql`
          update fine_tuning_consents set withdrawn_by = ${actor}, withdrawn_at = now()
          where project_id = ${projectId} and withdrawn_at is null
          returning ${CONSENT_COLUMNS}
        `),
      );
      return row ? toConsent(row) : null;
    },
  };
}

/** The use case writes and reads (RC-1124). The partial unique index refuses a second live use case of one name. */
export function createDrizzleUseCaseStore(db: Db): UseCaseStore {
  const getUseCase = async (projectId: string, id: string) =>
    rowsOf<UseCaseRow>(
      await db.execute(sql`
      select ${USE_CASE_COLUMNS} from fine_tuning_use_cases
      where project_id = ${projectId} and id = ${id}::uuid and archived_at is null
    `),
    ).map(toUseCase)[0] ?? null;
  const written = (rows: UseCaseRow[]): UseCaseWrite =>
    rows[0] ? { ok: true, useCase: toUseCase(rows[0]) } : { ok: false, reason: "not_found" };
  return {
    getUseCase: (projectId, id) => (isUuid(id) ? getUseCase(projectId, id) : Promise.resolve(null)),
    async listUseCases(projectId, options = {}) {
      const live = options.includeArchived ? sql`` : sql` and archived_at is null`;
      return rowsOf<UseCaseRow>(
        await db.execute(sql`
        select ${USE_CASE_COLUMNS} from fine_tuning_use_cases
        where project_id = ${projectId}${live}
        order by created_at desc, id
        limit ${MAX_USE_CASES}
      `),
      ).map(toUseCase);
    },
    async createUseCase(projectId, input, actor) {
      return nameTaken(async () =>
        written(
          rowsOf<UseCaseRow>(
            await db.execute(sql`
          insert into fine_tuning_use_cases (project_id, name, selector, created_by)
          values (${projectId}, ${input.name}, ${JSON.stringify(input.selector)}::jsonb, ${actor})
          returning ${USE_CASE_COLUMNS}
        `),
          ),
        ),
      );
    },
    async updateUseCase(projectId, id, patch) {
      if (!isUuid(id)) return { ok: false, reason: "not_found" };
      const sets = [
        ...(patch.name !== undefined ? [sql`name = ${patch.name}`] : []),
        ...(patch.selector !== undefined
          ? [sql`selector = ${JSON.stringify(patch.selector)}::jsonb`]
          : []),
        sql`updated_at = now()`,
      ];
      return nameTaken(async () =>
        written(
          rowsOf<UseCaseRow>(
            await db.execute(sql`
          update fine_tuning_use_cases set ${sql.join(sets, sql`, `)}
          where project_id = ${projectId} and id = ${id}::uuid and archived_at is null
          returning ${USE_CASE_COLUMNS}
        `),
          ),
        ),
      );
    },
    async archiveUseCase(projectId, id) {
      if (!isUuid(id)) return { ok: false, reason: "not_found" };
      return written(
        rowsOf<UseCaseRow>(
          await db.execute(sql`
        update fine_tuning_use_cases set archived_at = now(), updated_at = now()
        where project_id = ${projectId} and id = ${id}::uuid and archived_at is null
        returning ${USE_CASE_COLUMNS}
      `),
        ),
      );
    },
  };
}

/**
 * The model calls a use case selects (RC-1124). Turns and span names are this
 * adapter's own reads; the turn's traces and the calls go through the loaders
 * the session replay and the eval gate use.
 */
export function createDrizzleModelCallSource(db: ReadDb): ModelCallSource {
  return {
    async findClosedTurns(projectId, query) {
      if (query.taskIds.length === 0 && query.intentIds.length === 0) return [];
      return rowsOf<TurnRow>(await db.execute(matchedTurnsQuery(projectId, query))).map(
        toMatchedTurn,
      );
    },
    async turnTotals(projectId, query) {
      if (query.taskIds.length === 0 && query.intentIds.length === 0)
        return { turns: 0, firstEndedAt: null, lastEndedAt: null };
      const [row] = rowsOf<{
        turns: number | string;
        first_ended_at: Date | string | null;
        last_ended_at: Date | string | null;
      }>(await db.execute(turnTotalsQuery(projectId, query)));
      return {
        turns: Number(row?.turns ?? 0),
        firstEndedAt: row?.first_ended_at ? new Date(row.first_ended_at) : null,
        lastEndedAt: row?.last_ended_at ? new Date(row.last_ended_at) : null,
      };
    },
    async recentTasks(projectId, since) {
      return rowsOf<{ workflow_id: string; turns: number | string }>(
        await db.execute(recentTasksQuery(projectId, since)),
      ).map((row) => ({
        taskId: row.workflow_id,
        turns: Number(row.turns),
      }));
    },
    turnTraceIds: (projectId, turnIds) => loadTurnTraceIds(projectId, turnIds, db),
    modelCalls: (projectId, turns) => loadModelCalls(projectId, turns, {}, db),
    async spanNames(projectId, spans) {
      const out = new Map<string, string>();
      for (let i = 0; i < spans.length; i += SPAN_CHUNK) {
        const chunk = spans.slice(i, i + SPAN_CHUNK);
        const rows = rowsOf<{ trace_id: string; span_id: string; name: string }>(
          await db.execute(spanNamesQuery(projectId, chunk)),
        );
        for (const row of rows) out.set(`${row.trace_id}:${row.span_id}`, row.name);
      }
      return out;
    },
  };
}

// — Queries ———————————————————————————————————————————————————————————————————

const USE_CASE_COLUMNS = sql.raw(
  "id, project_id, name, selector, created_by, created_at, archived_at",
);
const CONSENT_COLUMNS = sql.raw(
  "id, project_id, given_by, given_at, text_version, withdrawn_by, withdrawn_at",
);

/** The project's active grant: one probe of `fine_tuning_consents_active_idx`. */
export function activeConsentQuery(projectId: string): SQL {
  return sql`
    select ${CONSENT_COLUMNS}
    from fine_tuning_consents
    where project_id = ${projectId} and withdrawn_at is null
    limit 1
  `;
}

const DECLARED = "declared:";
const OTLP = "otlp:";

/**
 * The closed turns a selector matches, newest first. A task's turns are a
 * range of `trace_turns_project_workflow_idx`. An intent's turns go forward
 * from its asks (`intent_cluster_assignments_cluster_idx`; a level-1 intent
 * reads its level-0 clusters by `parent_id`), placed in a turn as the Intents
 * breakdown places them: an OTLP turn by its trace's prompt, a declared turn
 * by its session and turn id, a search turn by its steps' events.
 */
export function matchedTurnsQuery(projectId: string, query: TurnQuery & { limit: number }): SQL {
  const { prelude, matched } = matchedTurns(projectId, query);
  return sql`${prelude}
    select distinct on (m.ended_at, m.id) m.id, m.workflow_id, m.started_at, m.ended_at
    from (${matched}) m
    order by m.ended_at desc, m.id
    limit ${query.limit}
  `;
}

/** How many closed turns a selector matches in the window, and the first and last `ended_at`. */
export function turnTotalsQuery(projectId: string, query: TurnQuery): SQL {
  const { prelude, matched } = matchedTurns(projectId, query);
  return sql`${prelude}
    select count(distinct m.id)::int as turns, min(m.ended_at) as first_ended_at, max(m.ended_at) as last_ended_at
    from (${matched}) m
  `;
}

type TurnQuery = {
  taskIds: readonly string[];
  intentIds: readonly string[];
  since: Date;
  until: Date;
};

function matchedTurns(projectId: string, query: TurnQuery): { prelude: SQL; matched: SQL } {
  const since = sql`${query.since.toISOString()}::timestamptz`;
  const until = sql`${query.until.toISOString()}::timestamptz`;
  const parts: SQL[] = [];
  if (query.taskIds.length > 0) {
    parts.push(sql`
      select t.id, t.workflow_id, t.started_at, t.ended_at
      from trace_turns t
      where t.project_id = ${projectId} and t.workflow_id in ${inList(query.taskIds)}
        and t.ended_at >= ${since} and t.ended_at < ${until} and t.status = 'closed'
    `);
  }
  if (query.intentIds.length > 0) {
    parts.push(sql`
      select t.id, t.workflow_id, t.started_at, t.ended_at
      from trace_turns t
      where t.project_id = ${projectId} and t.ended_at >= ${since} and t.ended_at < ${until} and t.status = 'closed'
        and (
          exists (select 1 from intent_asks a where a.kind = 'prompt' and t.turn_key = ${OTLP} || a.trace_id)
          or exists (select 1 from intent_asks a where a.kind = 'user_message' and a.session_id = t.session_id and t.turn_key = ${DECLARED} || a.turn_id)
          or exists (
            select 1 from trace_turn_steps s join intent_asks a on a.trace_event_id = s.trace_event_id
            where s.turn_id = t.id and s.kind = 'search'
          )
        )
    `);
  }
  const intentIds = sql.join(
    query.intentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const prelude =
    query.intentIds.length > 0
      ? sql`with intent_asks as materialized (
        select a.kind, a.trace_event_id, a.session_id, a.turn_id, a.trace_id
        from intent_cluster_assignments a
        where a.project_id = ${projectId}
          and a.cluster_id in (
            select c.id from intent_clusters c
            where c.project_id = ${projectId}
              and (c.id in (${intentIds}) or c.parent_id in (${intentIds}))
          )
          and a.occurred_at >= ${since} - interval '1 day' and a.occurred_at < ${until}
      ) `
      : sql``;
  return { prelude, matched: sql.join(parts, sql` union all `) };
}

/** The project's tasks with closed turns since `since`: a range of `trace_turns_project_workflow_idx`. */
export function recentTasksQuery(projectId: string, since: Date): SQL {
  return sql`
    select t.workflow_id, count(*)::int as turns
    from trace_turns t
    where t.project_id = ${projectId} and t.workflow_id is not null
      and t.ended_at >= ${since.toISOString()}::timestamptz and t.status = 'closed'
    group by t.workflow_id
    order by turns desc, t.workflow_id
    limit ${MAX_TASK_OPTIONS}
  `;
}

/** The names of a chunk of spans: one probe of `otel_spans_project_trace_idx` per trace. */
export function spanNamesQuery(
  projectId: string,
  spans: readonly { traceId: string; spanId: string }[],
): SQL {
  const traceIds = [...new Set(spans.map((span) => span.traceId))];
  const pairs = sql.join(
    spans.map((span) => sql`(${span.traceId}, ${span.spanId})`),
    sql`, `,
  );
  return sql`
    select s.trace_id, s.span_id, s.name
    from otel_spans s
    where s.project_id = ${projectId} and s.trace_id in ${inList(traceIds)}
      and (s.trace_id, s.span_id) in (${pairs})
  `;
}

// — Helpers ——————————————————————————————————————————————————————————————————

interface ConsentRow {
  id: string;
  project_id: string;
  given_by: string;
  given_at: Date | string;
  text_version: string;
  withdrawn_by: string | null;
  withdrawn_at: Date | string | null;
}

interface UseCaseRow {
  id: string;
  project_id: string;
  name: string;
  selector: UseCaseSelector | string;
  created_by: string;
  created_at: Date | string;
  archived_at: Date | string | null;
}

interface TurnRow {
  id: string;
  workflow_id: string | null;
  started_at: Date | string;
  ended_at: Date | string;
}

function toUseCase(row: UseCaseRow): UseCase {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    selector:
      typeof row.selector === "string"
        ? (JSON.parse(row.selector) as UseCaseSelector)
        : row.selector,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
  };
}

function toMatchedTurn(row: TurnRow): MatchedTurn {
  return {
    turnId: row.id,
    taskId: row.workflow_id,
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
  };
}

/** A write that hit the unique name index is `name_taken`; any other error propagates. */
async function nameTaken(write: () => Promise<UseCaseWrite>): Promise<UseCaseWrite> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err, "fine_tuning_use_cases_project_name_idx"))
      return { ok: false, reason: "name_taken" };
    throw err;
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (
    let current: unknown = err;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    const {
      code,
      constraint: name,
      message,
    } = current as { code?: string; constraint?: string; message?: string };
    if (code === "23505" && (name === constraint || message?.includes(constraint))) return true;
  }
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function inList(values: readonly string[]): SQL {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

function toConsent(row: ConsentRow): TrainingConsent {
  return {
    id: row.id,
    projectId: row.project_id,
    givenBy: row.given_by,
    givenAt: new Date(row.given_at),
    textVersion: row.text_version,
    withdrawnBy: row.withdrawn_by,
    withdrawnAt: row.withdrawn_at ? new Date(row.withdrawn_at) : null,
  };
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[];
}
