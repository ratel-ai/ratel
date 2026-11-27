import { currentVersion, type EvalCase } from "./domain/case";
import {
  type Dataset,
  type DatasetKind,
  type DatasetQuery,
  isQueryKind,
  MAX_ROW_LIMIT,
  rowKindOf,
} from "./domain/dataset";
import { datasetOf, type EvalDefinition } from "./domain/eval";
import { type DatasetRow, queryText } from "./history-view";
import { datasetHref, evalHref, turnHref } from "./paths";

/**
 * The page models of the Datasets pages (decision `datasets-first-class`, words of `eval-terms`):
 * the list of datasets and one dataset with its rows, or with its query. Plain data for the views.
 */

export const KIND_LABELS: Record<DatasetKind, string> = {
  fixed: "Fixed",
  last_traces: "Last traces",
  task_traces: "Traces of a task",
  rql: "RQL query",
  auto: "Ratel chooses",
};

/** What a person reads under a query: the rows are not kept until a run. */
export const FREEZE_NOTE =
  "Ratel resolves this query when a run starts, and the run freezes the rows that it used. The preview shows what it resolves now.";

/** The longest input text that a row of a table shows. */
const SHORT_TEXT = 160;

export type DatasetListRow = {
  datasetId: string;
  href: string;
  name: string;
  description: string | null;
  kind: DatasetKind;
  kindLabel: string;
  /** "12 cases" for a fixed dataset, the query in words for a query kind. */
  cases: string;
  /** The number of rows of a fixed dataset, for sorting. Null for a query kind. */
  rowCount: number | null;
  updatedAt: string;
  usedBy: Array<{ evalId: string; name: string; href: string }>;
};

export type DatasetPageRow = {
  rowId: string;
  name: string;
  kind: "trace" | "values";
  input: string;
  expectedOutput: string | null;
  /** The trace turn of a trace row. Null for typed values. */
  turnHref: string | null;
};

export type DatasetPage = {
  projectId: string;
  datasetId: string;
  name: string;
  description: string | null;
  kind: DatasetKind;
  kindLabel: string;
  updatedAt: string;
  usedBy: DatasetListRow["usedBy"];
} & (
  | { fixed: true; rows: DatasetPageRow[] }
  | { fixed: false; query: string; freezeNote: string; querySettings: Dataset["query"] }
);

export function datasetsPageModel(
  projectId: string,
  rows: readonly DatasetRow[],
): DatasetListRow[] {
  return rows.map((row) => ({
    datasetId: row.datasetId,
    href: datasetHref(projectId, row.datasetId),
    name: row.name,
    description: row.description,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind],
    cases: row.rows === null ? (row.query ?? KIND_LABELS[row.kind]) : casesText(row.rows),
    rowCount: row.rows,
    updatedAt: row.updatedAt,
    usedBy: row.evals.map(({ evalId, name }) => ({
      evalId,
      name,
      href: evalHref(projectId, evalId),
    })),
  }));
}

export function datasetPageModel({
  projectId,
  dataset,
  rows,
  evals,
}: {
  projectId: string;
  dataset: Dataset;
  /** The rows of a fixed dataset, the newest first. */
  rows: readonly EvalCase[];
  evals: readonly EvalDefinition[];
}): DatasetPage {
  const base = {
    projectId,
    datasetId: dataset.id,
    name: dataset.name,
    description: dataset.description,
    kind: dataset.query.kind,
    kindLabel: KIND_LABELS[dataset.query.kind],
    updatedAt: dataset.updatedAt.toISOString(),
    usedBy: evals
      .filter((definition) => datasetOf(definition) === dataset.id)
      .map(({ id, name }) => ({ evalId: id, name, href: evalHref(projectId, id) })),
  };
  if (isQueryKind(dataset.query)) {
    return {
      ...base,
      fixed: false,
      query: queryText(dataset.query) ?? "",
      freezeNote: FREEZE_NOTE,
      querySettings: dataset.query,
    };
  }
  return { ...base, fixed: true, rows: rows.map((row) => pageRow(projectId, row)) };
}

/** The input of a row as one text: a single text value is the text, anything else is JSON. */
export function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const values = Object.values(input);
    if (values.length === 1 && typeof values[0] === "string") return values[0];
  }
  return JSON.stringify(input) ?? "";
}

/** The rows whose name, description, kind or query has the text, in any case. */
export function filterDatasets(rows: readonly DatasetListRow[], text: string): DatasetListRow[] {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return [...rows];
  return rows.filter((row) =>
    [row.name, row.description ?? "", row.kindLabel, row.cases].some((field) =>
      field.toLowerCase().includes(wanted),
    ),
  );
}

export function shortText(text: string, max = SHORT_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function casesText(count: number): string {
  return count === 1 ? "1 case" : `${count} cases`;
}

function pageRow(projectId: string, row: EvalCase): DatasetPageRow {
  const version = currentVersion(row);
  const kind = version ? rowKindOf(version) : "values";
  const turnId = version?.sourceTurnId ?? null;
  return {
    rowId: row.id,
    name: row.name,
    kind,
    input: inputText(version?.input ?? null),
    expectedOutput: version?.expectedOutput ?? null,
    turnHref: turnId ? turnHref(projectId, turnId) : null,
  };
}

/** What the "New dataset" dialog holds before it sends. */
export type DatasetDraft = {
  kind: DatasetKind;
  /** The rows that a query resolves, as typed. */
  limit: string;
  /** The task of "Traces of a task", or the task that "Ratel chooses" keeps to. Empty: none. */
  taskId: string;
  rql: string;
};

/** What each kind does, in one sentence, under the kind field. */
export const KIND_HELP: Record<DatasetKind, string> = {
  fixed: "A saved set of rows. Start it empty, or with traces that you choose.",
  last_traces: "The newest traces of the project, up to the number you give.",
  task_traces: "The newest traces of one task, up to the number you give.",
  rql: "The traces that an RQL query finds. The query must give a trace_id column.",
  auto: "Ratel takes the newest failed traces first, then a spread over the tasks.",
};

/**
 * The query of a draft, or the reason it cannot be sent yet. A query kind needs a whole number of
 * rows from 1 to 500. A task kind needs its task, and RQL its text.
 */
export function draftQuery(
  draft: DatasetDraft,
): { ok: true; query: DatasetQuery } | { ok: false; message: string } {
  if (draft.kind === "fixed") return { ok: true, query: { kind: "fixed" } };
  const limit = Number(draft.limit.trim());
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROW_LIMIT) {
    return { ok: false, message: `Give a number of traces from 1 to ${MAX_ROW_LIMIT}.` };
  }
  const taskId = draft.taskId.trim();
  switch (draft.kind) {
    case "last_traces":
      return { ok: true, query: { kind: "last_traces", limit } };
    case "task_traces":
      if (!taskId) return { ok: false, message: "Choose the task." };
      return { ok: true, query: { kind: "task_traces", taskId, limit } };
    case "rql": {
      const text = draft.rql.trim();
      if (!text) return { ok: false, message: "Write the query." };
      return { ok: true, query: { kind: "rql", text, limit } };
    }
    case "auto":
      return { ok: true, query: { kind: "auto", taskId: taskId || null, limit } };
  }
}
