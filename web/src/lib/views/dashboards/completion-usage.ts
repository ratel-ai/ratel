import { sql } from "drizzle-orm";
import { QUERY_VERSION } from "@/lib/contracts/query";
import type { MetricsDb } from "@/lib/synthesis/metrics/query";
import {
  countRqlUsage,
  NO_USAGE,
  RQL_VERSION,
  type RqlCompletionUsage,
  type RqlTableName,
} from "@/lib/synthesis/rql/compile";
import { RQL_TABLES } from "@/lib/synthesis/rql/domain/catalog";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { type RqlGate, type RqlRunDeps, rqlConsoleGate } from "@/lib/synthesis/rql/run";

/**
 * What the RQL field of one project orders its list by (decision `completion-ranking`), read once
 * at page load: the names the project's saved queries use, alone and two together (the newest
 * `MAX_SAVED_QUERIES` texts of its dashboard widgets and alert rules, read with the compiler's
 * parser), and, by table, the columns that hold data in its newest `SAMPLE_ROWS` rows of the last
 * `SAMPLE_DAYS` days, read through RQL on the read-only path. Only the project of the caller: every
 * read names it. A table whose read fails is left out: no evidence. The reads are not the person's:
 * they send no RQL run event, and each takes a console place of the project only when one is free
 * at once, so a widget never waits for one. Server only.
 */

/** The saved RQL texts read, at most: the newest first. */
export const MAX_SAVED_QUERIES = 200;
/** The rows of each table read for which columns hold data. */
export const SAMPLE_ROWS = 20;
/** The days back the rows are read from. */
export const SAMPLE_DAYS = 7;

export interface CompletionUsageDeps {
  db: MetricsDb;
  /** Runs one RQL text for the project: `rqlSample` by default. */
  sample?: (
    projectId: string,
    text: string,
  ) => Promise<{ columns: { name: string }[]; rows: unknown[][] }>;
  /** The run of the default sample: the RQL pool, and a console place only when one is free. */
  run?: Partial<RqlRunDeps>;
  now?: Date;
}

export async function loadCompletionUsage(
  projectId: string,
  { db, sample, run = {}, now = new Date() }: CompletionUsageDeps,
): Promise<RqlCompletionUsage> {
  const texts = await savedTexts(projectId, db);
  const read = sample ?? rqlSample(db, run, now);
  const columnsWithData: RqlCompletionUsage["columnsWithData"] = {};
  // One table at a time: one place of the project in the console's gate.
  for (const { name, timeColumn } of RQL_TABLES) {
    const found = await columnsWithDataOf(projectId, name, timeColumn, read);
    if (found) columnsWithData[name] = found;
  }
  return { ...NO_USAGE, ...countRqlUsage(texts), columnsWithData };
}

/** The newest RQL texts of the project's widgets and alert rules. */
async function savedTexts(projectId: string, db: MetricsDb): Promise<string[]> {
  const result = await db.execute(sql`
    select text from (
      select w.value -> 'query' ->> 'text' as text, d.updated_at
      from dashboards d,
        jsonb_array_elements(case jsonb_typeof(d.widgets) when 'array' then d.widgets else '[]'::jsonb end) w
      where d.project_id = ${projectId}::uuid and w.value -> 'query' ->> 'kind' = 'sql'
      union all
      select r.query ->> 'text', r.updated_at
      from alert_rules r
      where r.project_id = ${projectId}::uuid and r.query ->> 'kind' = 'sql'
    ) saved
    where text is not null
    order by updated_at desc
    limit ${MAX_SAVED_QUERIES}`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as { text: string }[];
  return rows.map(({ text }) => text);
}

/** The columns of `table` that hold a value in the sampled rows, or null when the read failed. */
async function columnsWithDataOf(
  projectId: string,
  table: RqlTableName,
  timeColumn: string,
  read: NonNullable<CompletionUsageDeps["sample"]>,
): Promise<string[] | null> {
  try {
    const { columns, rows } = await read(
      projectId,
      `select * from ${table} order by ${timeColumn} desc limit ${SAMPLE_ROWS}`,
    );
    return columns
      .filter((_, index) => rows.some((row) => holdsValue(row[index])))
      .map(({ name }) => name);
  } catch {
    return null;
  }
}

/** A zero or `false` is a value; a null, an empty text, list or map is not. */
function holdsValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** A console place of the project when one is free now; never a wait behind a widget. */
const FREE_PLACE_ONLY: RqlGate = {
  enter: (projectId) => rqlConsoleGate.enter(projectId),
  wait: async (projectId) => rqlConsoleGate.enter(projectId),
};

/** The default sample: the RQL path over the last `SAMPLE_DAYS` days, with no run event. */
function rqlSample(
  db: MetricsDb,
  run: Partial<RqlRunDeps>,
  now: Date,
): NonNullable<CompletionUsageDeps["sample"]> {
  const runner = sqlQueryRunner({
    run: { gate: FREE_PLACE_ONLY, observe: async () => {}, ...run },
  });
  const since = new Date(now.getTime() - SAMPLE_DAYS * 86_400_000);
  return (projectId, text) =>
    runner(
      projectId,
      { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
      { since, until: now },
      db,
    );
}
