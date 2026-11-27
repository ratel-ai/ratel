import {
  type DatasetQuery,
  isQueryKind,
  type ResolvedQuery,
  type ResolvedRow,
} from "./domain/dataset";
import { caseFromTurn } from "./domain/from-turn";
import { preview } from "./page-model";
import type { TraceSource } from "./ports/trace-source";

export type ResolveRefusal =
  | "not_a_query"
  | "no_content_access"
  | "rql_off"
  | "query_failed"
  | "too_many_rows"
  | "no_rows";

export type ResolveResult =
  | { ok: true; rows: ResolvedRow[] }
  | { ok: false; reason: ResolveRefusal; message: string };

const TRACE_COLUMN = "trace_id";
export const RQL_OFF_MESSAGE =
  "RQL is not on for this project, so an RQL dataset cannot run. Use another kind of dataset.";

/** An RQL dataset needs RQL (`customMonitoring`) on for the project. Null: it may run. */
export async function rqlRefusal(
  projectId: string,
  query: DatasetQuery,
  source: Pick<TraceSource, "rqlEnabled">,
): Promise<{ ok: false; reason: "rql_off"; message: string } | null> {
  if (query.kind !== "rql" || (await source.rqlEnabled(projectId))) return null;
  return refused("rql_off", RQL_OFF_MESSAGE);
}
/** Turns loaded at the same time: each one reads its traces. */
const PARALLEL = 5;

/**
 * Resolves the rows of a query dataset when a run starts. Each row is a turn with a frozen copy of
 * its input, its earlier messages and the fixtures of its tools, as a row saved from a turn has. A
 * turn with no captured input is left out. Turn content rules apply: a project that does not let
 * Ratel read captured text gets no row.
 */
export async function resolveDataset(
  projectId: string,
  query: DatasetQuery,
  source: TraceSource,
): Promise<ResolveResult> {
  const found = await findTurns(projectId, query, source);
  if (!found.ok) return found;
  const { turnIds } = found;
  const readOnly = await source.readOnlyTools(projectId);
  const rows: Array<ResolvedRow | null> = new Array(turnIds.length).fill(null);
  await inParallel(turnIds, async (turnId, index) => {
    const turn = await source.loadTurn(projectId, turnId);
    const made = turn && caseFromTurn(turn, readOnly);
    if (made) rows[index] = { turnId, content: made.content, sourceOutput: made.sourceOutput };
  });
  const kept = rows.filter((row) => row !== null);
  if (kept.length === 0) {
    return refused("no_rows", "The query found no turn with a captured input.");
  }
  return { ok: true, rows: kept };
}

/** The rows that a preview shows. */
export const PREVIEW_ROWS = 10;

export type PreviewRow = { turnId: string; input: string | null };
export type PreviewResult =
  | { ok: true; found: number; rows: PreviewRow[] }
  | { ok: false; reason: ResolveRefusal; message: string };

/**
 * What a query dataset resolves to now, as a run would find it: the number of turns found (a turn
 * with no captured input is left out when a run freezes them) and the first rows with their input,
 * cut. It reads `PREVIEW_ROWS` turns only and freezes nothing. The refusals are the ones of a run.
 */
export async function previewDataset(
  projectId: string,
  query: DatasetQuery,
  source: TraceSource,
): Promise<PreviewResult> {
  const found = await findTurns(projectId, query, source);
  if (!found.ok) return found;
  const first = found.turnIds.slice(0, PREVIEW_ROWS);
  const readOnly = await source.readOnlyTools(projectId);
  const rows: Array<PreviewRow | null> = new Array(first.length).fill(null);
  await inParallel(first, async (turnId, index) => {
    const turn = await source.loadTurn(projectId, turnId);
    const made = turn && caseFromTurn(turn, readOnly);
    if (made) rows[index] = { turnId, input: preview(made.content.input) };
  });
  return { ok: true, found: found.turnIds.length, rows: rows.filter((row) => row !== null) };
}

/** The distinct turns of a query, at most its limit, in order. The content rule comes first. */
async function findTurns(
  projectId: string,
  query: DatasetQuery,
  source: TraceSource,
): Promise<{ ok: true; turnIds: string[] } | Extract<ResolveResult, { ok: false }>> {
  if (!isQueryKind(query)) return refused("not_a_query", "A fixed dataset holds its rows.");
  const rqlOff = await rqlRefusal(projectId, query, source);
  if (rqlOff) return rqlOff;
  if (!(await source.readContent(projectId))) {
    return refused(
      "no_content_access",
      "This project does not let Ratel read captured text, so no row can be built from its traces. An admin can change it in Settings.",
    );
  }
  const found = await turnsOf(projectId, query, source);
  if (!found.ok) return found;
  const turnIds = [...new Set(found.turnIds)].slice(0, query.limit);
  if (turnIds.length === 0) {
    return refused("no_rows", "The query found no turn with a captured input.");
  }
  return { ok: true, turnIds };
}

async function turnsOf(
  projectId: string,
  query: ResolvedQuery,
  source: TraceSource,
): Promise<{ ok: true; turnIds: string[] } | Extract<ResolveResult, { ok: false }>> {
  switch (query.kind) {
    case "last_traces":
      return { ok: true, turnIds: await source.lastTurns(projectId, query.limit) };
    case "task_traces":
      return { ok: true, turnIds: await source.taskTurns(projectId, query.taskId, query.limit) };
    case "auto":
      return { ok: true, turnIds: await source.chooseTurns(projectId, query.taskId, query.limit) };
    case "rql":
      return rqlTurns(projectId, query, source);
  }
}

/** The distinct turns of the `trace_id` column, in the order of the rows. */
async function rqlTurns(
  projectId: string,
  { text, limit }: Extract<ResolvedQuery, { kind: "rql" }>,
  source: TraceSource,
): Promise<{ ok: true; turnIds: string[] } | Extract<ResolveResult, { ok: false }>> {
  const table = await source.runRql(projectId, text);
  if (!table.ok) return refused("query_failed", `The RQL query failed. ${table.message}`);
  const column = table.columns.findIndex(({ name }) => name === TRACE_COLUMN);
  if (column < 0) {
    return refused("query_failed", `The RQL query must give a ${TRACE_COLUMN} column.`);
  }
  const traceIds = [
    ...new Set(table.rows.flatMap((row) => (typeof row[column] === "string" ? [row[column]] : []))),
  ];
  const turns = await source.turnsOfTraces(projectId, traceIds);
  const turnIds = [...new Set(traceIds.flatMap((id) => turns.get(id) ?? []))];
  if (turnIds.length > limit) {
    return refused(
      "too_many_rows",
      `The query finds more than ${limit} turns. Add a LIMIT, narrow the WHERE, or raise the limit of the dataset (at most 500).`,
    );
  }
  return { ok: true, turnIds };
}

async function inParallel<T>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    for (let index = next++; index < items.length; index = next++) {
      await work(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, lane));
}

function refused<R extends ResolveRefusal>(reason: R, message: string) {
  return { ok: false as const, reason, message };
}
