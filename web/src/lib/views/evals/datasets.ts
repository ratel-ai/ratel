import type { CaseVersion, EvalCase } from "./domain/case";
import { chooseTurns } from "./domain/choose";
import {
  type Dataset,
  MAX_ROW_LIMIT,
  type ResolvedRow,
  rowLimit,
  tooManyRows,
} from "./domain/dataset";
import { rowsOf } from "./domain/experiment";
import type { CaseStore } from "./ports/case-store";
import type { DatasetSources } from "./ports/dataset-sources";

/**
 * The rows of a dataset when a run starts (decision `datasets-first-class`). A fixed dataset gives
 * the newest version of each of its rows. A query kind is resolved now, through the ports, and the
 * run keeps the rows that it got. A resolved set has at most the limit of the dataset (50 when it
 * gives none, 500 at most), and a set over it is refused with the reason. Rows from traces need the
 * captured text: a project that does not let Ratel read it gets a refusal that says so.
 */

export type DatasetRow =
  | { kind: "case"; evalCase: EvalCase; caseVersion: CaseVersion }
  | { kind: "run"; row: ResolvedRow };

export type ResolveRefusal = "no_content_access" | "too_many_rows" | "invalid_query" | "no_cases";

export type ResolvedDataset =
  | { ok: true; rows: DatasetRow[]; skipped: number }
  | { ok: false; reason: ResolveRefusal; message: string };

export type ResolveDeps = {
  cases: Pick<CaseStore, "listDataset">;
  sources: DatasetSources;
  now: () => Date;
};

export const NO_CONTENT_MESSAGE =
  "This project does not let Ratel read the captured text of its traces, so Ratel cannot make rows from traces. An admin can change it in Settings.";

/** How many turns a source reads for "let Ratel choose": more than it takes, so it can choose. */
const CHOOSE_POOL = 4;
const DAY_MS = 86_400_000;

export async function resolveDataset(
  projectId: string,
  dataset: Dataset,
  label: string | null,
  deps: ResolveDeps,
): Promise<ResolvedDataset> {
  const { definition } = dataset;
  if (definition.kind === "fixed") {
    const rows = rowsOf(await deps.cases.listDataset(projectId, dataset.id), label).map(
      ({ evalCase, caseVersion }): DatasetRow => ({ kind: "case", evalCase, caseVersion }),
    );
    const over = tooManyRows(rows.length);
    if (over) return { ok: false, reason: "too_many_rows", message: over };
    return { ok: true, rows, skipped: 0 };
  }
  if (!(await deps.sources.readContent(projectId))) {
    return { ok: false, reason: "no_content_access", message: NO_CONTENT_MESSAGE };
  }
  const limit = rowLimit(definition);
  const { sources } = deps;
  let turnIds: string[];
  switch (definition.kind) {
    case "last_traces":
      turnIds = await sources.newestTurns(projectId, limit);
      break;
    case "task_traces":
      turnIds = await sources.taskTurns(projectId, definition.taskId, limit);
      break;
    case "choose":
      turnIds = definition.taskId
        ? await sources.chooseForTask(projectId, definition.taskId, limit)
        : chooseTurns(await sources.chooseCandidates(projectId, limit * CHOOSE_POOL), limit);
      break;
    case "rql": {
      const until = deps.now();
      const since = new Date(until.getTime() - definition.days * DAY_MS);
      const found = await sources.rqlTraces(projectId, definition.text, { since, until });
      if (!found.ok) return { ok: false, reason: "invalid_query", message: found.message };
      const traceIds = [...new Set(found.traceIds)];
      if (found.truncated || traceIds.length > limit) {
        const count = found.truncated ? `more than ${traceIds.length}` : String(traceIds.length);
        return {
          ok: false,
          reason: "too_many_rows",
          message: `The query gives ${count} traces. The dataset takes at most ${limit} (at most ${MAX_ROW_LIMIT} when you raise its limit). Add a LIMIT or narrow the WHERE.`,
        };
      }
      turnIds = await sources.turnsOfTraces(projectId, traceIds);
      break;
    }
  }
  // A source can give more than it was asked: the limit holds for the set.
  const over = tooManyRows(turnIds.length, limit);
  if (over) return { ok: false, reason: "too_many_rows", message: over };
  const rows: DatasetRow[] = [];
  let skipped = 0;
  for (const turnId of new Set(turnIds)) {
    const row = await sources.turnRow(projectId, turnId);
    if (row) rows.push({ kind: "run", row });
    else skipped += 1;
  }
  return { ok: true, rows, skipped };
}
