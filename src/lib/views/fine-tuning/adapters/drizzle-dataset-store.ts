import { sql } from "drizzle-orm";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import type { getDb } from "@/lib/platform/db/client";
import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { scorersFor } from "@/lib/views/task-scorers/store";
import type { Scorer, ScorerRun } from "@/lib/views/task-scorers/types";
import type {
  Dataset,
  DatasetCounts,
  DatasetFailure,
  DatasetSettings,
  DatasetStatus,
} from "../domain/dataset";
import type { RedactionCounts } from "../domain/redaction";
import type { RowContent, StoredRow } from "../domain/rows";
import type { BuildFactSource, DatasetStore, TurnFacts } from "../ports/store";

/**
 * Dataset versions over Postgres (RC-1128). Every query filters `project_id`
 * (rows through their dataset). There is no row UPDATE here, and the table's
 * trigger refuses one: a stored row never changes.
 */

type Db = Pick<
  ReturnType<typeof getDb>,
  "select" | "selectDistinct" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute"
>;

const ID_CHUNK = 500;
const MAX_LISTED = 100;
const COLUMNS = sql.raw(
  "id, project_id, use_case_id, version, status, settings, content_hash, counts, redaction_report, created_by, created_at, failed_reason",
);

export function createDrizzleDatasetStore(db: Db): DatasetStore {
  const one = async (query: ReturnType<typeof sql>) =>
    rowsOf<DatasetDbRow>(await db.execute(query)).map(toDataset)[0] ?? null;
  return {
    async createBuilding(projectId, input) {
      // Two builds at once may pick the same number: the unique index refuses one, and it tries again.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const created = await one(sql`
            insert into fine_tuning_datasets (project_id, use_case_id, version, status, settings, created_by)
            select ${projectId}, ${input.useCaseId}::uuid, coalesce(max(version), 0) + 1, 'building', ${JSON.stringify(input.settings)}::jsonb, ${input.createdBy}
            from fine_tuning_datasets where use_case_id = ${input.useCaseId}::uuid
            returning ${COLUMNS}
          `);
          if (!created) throw new Error("dataset insert returned no row");
          return created;
        } catch (err) {
          if (attempt < 3 && isUniqueViolation(err)) continue;
          throw err;
        }
      }
    },
    getDataset: (projectId, id) =>
      isUuid(id)
        ? one(
            sql`select ${COLUMNS} from fine_tuning_datasets where project_id = ${projectId} and id = ${id}::uuid`,
          )
        : Promise.resolve(null),
    async listDatasets(projectId, useCaseId) {
      if (!isUuid(useCaseId)) return [];
      return rowsOf<DatasetDbRow>(
        await db.execute(sql`
        select ${COLUMNS} from fine_tuning_datasets
        where project_id = ${projectId} and use_case_id = ${useCaseId}::uuid
        order by version desc
        limit ${MAX_LISTED}
      `),
      ).map(toDataset);
    },
    async appendRows(projectId, id, rows, progress) {
      // One statement: the rows and the progress land together, or not at all. The rows
      // travel as one JSON parameter, so a page of any size stays one bind.
      const values = JSON.stringify(
        rows.map((row) => ({
          ordinal: row.ordinal,
          side: row.side,
          content: row.content,
          row_hash: row.rowHash,
          trace_id: row.traceId,
          span_id: row.spanId,
          turn_id: row.turnId,
          captured_at: row.capturedAt.toISOString(),
        })),
      );
      const [result] = rowsOf<{ building: number | string }>(
        await db.execute(sql`
        with ds as (
          update fine_tuning_datasets
          set counts = ${JSON.stringify(progress.counts)}::jsonb, redaction_report = ${JSON.stringify(progress.redaction)}::jsonb
          where project_id = ${projectId} and id = ${id}::uuid and status = 'building'
          returning id
        ), ins as (
          insert into fine_tuning_dataset_rows (dataset_id, ordinal, side, content, row_hash, trace_id, span_id, turn_id, captured_at)
          select ds.id, r.ordinal, r.side, r.content, r.row_hash, r.trace_id, r.span_id, r.turn_id, r.captured_at
          from ds, jsonb_to_recordset(${values}::jsonb) as r(
            ordinal int, side text, content jsonb, row_hash text, trace_id text, span_id text, turn_id uuid, captured_at timestamptz
          )
          returning 1
        )
        select (select count(*) from ds) as building, (select count(*) from ins) as inserted
      `),
      );
      return Number(result?.building ?? 0) > 0;
    },
    async storedRows(projectId, id) {
      if (!isUuid(id)) return [];
      return rowsOf<{ ordinal: number; content: RowContent | string; row_hash: string }>(
        await db.execute(sql`
        select r.ordinal, r.content, r.row_hash
        from fine_tuning_dataset_rows r
        join fine_tuning_datasets d on d.id = r.dataset_id
        where d.project_id = ${projectId} and r.dataset_id = ${id}::uuid
        order by r.ordinal
      `),
      ).map(
        (row): StoredRow => ({
          ordinal: Number(row.ordinal),
          content: parsed(row.content),
          rowHash: row.row_hash,
        }),
      );
    },
    async markReady(projectId, id, result) {
      const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
        update fine_tuning_datasets
        set status = 'ready', content_hash = ${result.contentHash},
            counts = ${JSON.stringify(result.counts)}::jsonb, redaction_report = ${JSON.stringify(result.redaction)}::jsonb
        where project_id = ${projectId} and id = ${id}::uuid and status = 'building'
        returning id
      `),
      );
      return rows.length > 0;
    },
    async markFailed(projectId, id, reason) {
      const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
        with ds as (
          update fine_tuning_datasets set status = 'failed', failed_reason = ${reason}
          where project_id = ${projectId} and id = ${id}::uuid and status = 'building'
          returning id
        ), gone as (
          delete from fine_tuning_dataset_rows where dataset_id in (select id from ds)
        )
        select id from ds
      `),
      );
      return rows.length > 0;
    },
    async delete(projectId, id) {
      if (!isUuid(id)) return false;
      const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
        delete from fine_tuning_datasets where project_id = ${projectId} and id = ${id}::uuid returning id
      `),
      );
      return rows.length > 0;
    },
    async deleteDatasets(projectId) {
      // Rows go with their dataset (on delete cascade).
      const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
        delete from fine_tuning_datasets where project_id = ${projectId} returning id
      `),
      );
      return rows.length;
    },
  };
}

/** What a build reads besides the turns and calls the use case resolves to. */
export function createDrizzleBuildFactSource(db: Db): BuildFactSource {
  return {
    async turnFacts(projectId, turnIds) {
      const out = new Map<string, TurnFacts>();
      for (const ids of chunk(turnIds.filter(isUuid), ID_CHUNK)) {
        const rows = rowsOf<{
          id: string;
          session_id: string | null;
          end_user_key: string | null;
          error_count: number;
          corrections: number | string;
        }>(
          await db.execute(sql`
            select t.id, t.session_id, t.end_user_key, t.error_count,
              (select count(*) from trace_self_corrections c where c.project_id = ${projectId} and c.turn_id = t.id) as corrections
            from trace_turns t
            where t.project_id = ${projectId} and t.id in ${uuidList(ids)}
          `),
        );
        for (const row of rows) {
          out.set(row.id, {
            sessionId: row.session_id,
            endUserKey: row.end_user_key,
            errorCount: Number(row.error_count),
            selfCorrections: Number(row.corrections),
          });
        }
      }
      return out;
    },
    async taskScorers(projectId, taskIds) {
      const out = new Map<string, Scorer[]>();
      for (const taskId of taskIds) {
        out.set(
          taskId,
          (await scorersFor(projectId, taskId, db))
            .filter((scorer) => scorer.enabled)
            .map(({ enabled: _e, source: _s, version: _v, ...scorer }) => scorer as Scorer),
        );
      }
      return out;
    },
    async scorerRuns(projectId, turnIds, expectedTool) {
      const runs = await loadRuns(projectId, turnIds, db);
      const out = new Map<string, ScorerRun>();
      for (const [turnId, run] of runs) out.set(turnId, recordedView(run, expectedTool(turnId)));
      return out;
    },
    // Owned (ADR-0030): user scorers (`scorers`, `run_scores`) are the Evals area, which the core
    // does not have, so no run has a user scorer result and none is dropped for one.
    async userScores(_projectId, _turnIds) {
      return new Map<string, { status: "pass" | "fail" | "skip" }[]>();
    },
    async evalCaseTurnIds(projectId, taskIds) {
      if (taskIds.length === 0) return new Set();
      const rows = rowsOf<{ turn_id: string }>(
        await db.execute(sql`
        select distinct c.turn_id from task_eval_cases c
        where c.project_id = ${projectId} and c.task_id in (${sql.join(
          taskIds.map((id) => sql`${id}`),
          sql`, `,
        )}) and c.excluded_at is null
      `),
      );
      return new Set(rows.map((row) => row.turn_id));
    },
    modelCalls: (projectId, turns) => loadModelCalls(projectId, turns, {}, db),
    async callPayloads(projectId, eventIds) {
      const out = new Map<string, CloudEvent | null>();
      for (const ids of chunk(eventIds.filter(isUuid), ID_CHUNK)) {
        const rows = rowsOf<{ id: string; payload: CloudEvent | string | null }>(
          await db.execute(sql`
          select e.id, e.payload from events e where e.project_id = ${projectId} and e.id in ${uuidList(ids)}
        `),
        );
        for (const row of rows) out.set(row.id, row.payload === null ? null : parsed(row.payload));
      }
      return out;
    },
  };
}

interface DatasetDbRow {
  id: string;
  project_id: string;
  use_case_id: string;
  version: number;
  status: DatasetStatus;
  settings: DatasetSettings | string;
  content_hash: string | null;
  counts: DatasetCounts | string | null;
  redaction_report: RedactionCounts | string | null;
  created_by: string;
  created_at: Date | string;
  failed_reason: DatasetFailure | null;
}

function toDataset(row: DatasetDbRow): Dataset {
  return {
    id: row.id,
    projectId: row.project_id,
    useCaseId: row.use_case_id,
    version: Number(row.version),
    status: row.status,
    settings: parsed(row.settings),
    contentHash: row.content_hash,
    counts: row.counts === null ? null : parsed(row.counts),
    redactionReport: row.redaction_report === null ? null : parsed(row.redaction_report),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    failedReason: row.failed_reason,
  };
}

function parsed<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function uuidList(ids: readonly string[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

function isUniqueViolation(err: unknown): boolean {
  for (
    let current: unknown = err;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    const { code, message } = current as { code?: string; message?: string };
    if (code === "23505" || message?.includes("fine_tuning_datasets_use_case_version_idx"))
      return true;
  }
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[];
}
