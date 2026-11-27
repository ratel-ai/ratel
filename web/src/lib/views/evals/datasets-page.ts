import { currentVersion as currentRow, type EvalCase } from "./domain/case";
import { type Dataset, type DatasetKind, type DatasetQuery, rowKindOf } from "./domain/dataset";
import { datasetOf, type EvalDefinition } from "./domain/eval";
import { datasetsView } from "./history-view";
import type { DatasetSummary } from "./ports/dataset-store";
import { preview } from "./page-model";
import { evalHref, turnHref } from "./paths";

/**
 * The Datasets page and one dataset (decision `datasets-first-class`), as plain data. A row saved
 * from a trace turn links to its turn. Captured text follows the content rule of the project: a
 * trace row shows its input only when the project lets Ratel read captured text. Typed values are
 * not captured text.
 */

export const KIND_LABELS: Record<DatasetKind, string> = {
  fixed: "Fixed rows",
  last_traces: "Last traces",
  task_traces: "Traces of a task",
  rql: "RQL query",
  auto: "Ratel chooses",
};

export type DatasetListRow = {
  datasetId: string;
  name: string;
  kind: DatasetKind;
  kindLabel: string;
  /** "12 rows" for a fixed dataset, the query in words for a query kind. */
  size: string;
  /** Monospace when the size is the RQL text. */
  rql: boolean;
  updatedAt: string;
  usedBy: Array<{ evalId: string; name: string; href: string }>;
};

export type DatasetsPageModel = { projectId: string; rows: DatasetListRow[] };

export function datasetsPageModel(
  projectId: string,
  datasets: readonly DatasetSummary[],
  evals: readonly EvalDefinition[],
  taskNames: ReadonlyMap<string, string> = new Map(),
): DatasetsPageModel {
  const queries = new Map(datasets.map(({ id, query }) => [id, query]));
  return {
    projectId,
    rows: datasetsView(datasets, evals).map((row) => {
      const query = queries.get(row.datasetId) ?? { kind: "fixed" as const };
      return {
        datasetId: row.datasetId,
        name: row.name,
        kind: row.kind,
        kindLabel: KIND_LABELS[row.kind],
        size:
          query.kind === "fixed"
            ? countText(row.rows ?? 0)
            : query.kind === "rql"
              ? query.text
              : queryWords(query, taskNames),
        rql: query.kind === "rql",
        updatedAt: row.updatedAt,
        usedBy: row.evals.map(({ evalId, name }) => ({
          evalId,
          name,
          href: evalHref(projectId, evalId),
        })),
      };
    }),
  };
}

/** The rows whose name, kind, size or evals have the text, any case. */
export function filterDatasets(rows: readonly DatasetListRow[], text: string): DatasetListRow[] {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") return [...rows];
  return rows.filter((row) =>
    [row.name, row.kindLabel, row.size, ...row.usedBy.map(({ name }) => name)].some((field) =>
      field.toLowerCase().includes(wanted),
    ),
  );
}

export type DatasetRowView = {
  rowId: string;
  name: string;
  kind: "trace" | "values";
  /** The input, cut. Null when the content rule withholds it. */
  input: string | null;
  expectedOutput: string | null;
  /** The turn page of a trace row. Null for typed values, and for a row from a sandbox run. */
  traceHref: string | null;
  version: number;
  updatedAt: string;
};

export type DatasetPageModel = {
  projectId: string;
  datasetId: string;
  name: string;
  description: string | null;
  kind: DatasetKind;
  kindLabel: string;
  /** A query kind: what it reads, in words, and the RQL text. Null for a fixed dataset. */
  query: { words: string; rql: string | null; limit: number } | null;
  rows: DatasetRowView[];
  /** True when a trace row hides its input: the project does not let Ratel read captured text. */
  contentWithheld: boolean;
  usedBy: Array<{ evalId: string; name: string; href: string }>;
  updatedAt: string;
};

export function datasetPageModel({
  projectId,
  dataset,
  rows,
  evals,
  readContent,
  taskNames = new Map(),
}: {
  projectId: string;
  dataset: Dataset;
  rows: readonly EvalCase[];
  evals: readonly EvalDefinition[];
  /** The content rule of the project. */
  readContent: boolean;
  taskNames?: ReadonlyMap<string, string>;
}): DatasetPageModel {
  const { query } = dataset;
  const views = rows.flatMap((row): DatasetRowView[] => {
    const version = currentRow(row);
    if (!version) return [];
    const kind = rowKindOf(version);
    const withheld = kind === "trace" && !readContent;
    return [
      {
        rowId: row.id,
        name: row.name,
        kind,
        input: withheld ? null : preview(version.input),
        expectedOutput:
          withheld || version.expectedOutput === null ? null : preview(version.expectedOutput),
        traceHref: version.sourceTurnId ? turnHref(projectId, version.sourceTurnId) : null,
        version: version.number,
        updatedAt: version.updatedAt.toISOString(),
      },
    ];
  });
  return {
    projectId,
    datasetId: dataset.id,
    name: dataset.name,
    description: dataset.description,
    kind: query.kind,
    kindLabel: KIND_LABELS[query.kind],
    query:
      query.kind === "fixed"
        ? null
        : {
            words: queryWords(query, taskNames),
            rql: query.kind === "rql" ? query.text : null,
            limit: query.limit,
          },
    rows: views,
    contentWithheld: !readContent && views.some(({ kind }) => kind === "trace"),
    usedBy: evals
      .filter((definition) => datasetOf(definition) === dataset.id)
      .map(({ id, name }) => ({ evalId: id, name, href: evalHref(projectId, id) })),
    updatedAt: dataset.updatedAt.toISOString(),
  };
}

/** What a query kind reads, in words, with the name of its task. */
export function queryWords(query: DatasetQuery, taskNames: ReadonlyMap<string, string>): string {
  const task = (id: string) => `"${taskNames.get(id) ?? id}"`;
  switch (query.kind) {
    case "fixed":
      return "Fixed rows";
    case "last_traces":
      return `The last ${query.limit} traces`;
    case "task_traces":
      return `The last ${query.limit} traces of the task ${task(query.taskId)}`;
    case "rql":
      return `Up to ${query.limit} traces of an RQL query`;
    case "auto":
      return query.taskId === null
        ? `Ratel chooses ${query.limit} traces`
        : `Ratel chooses ${query.limit} traces of the task ${task(query.taskId)}`;
  }
}

function countText(count: number): string {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}
