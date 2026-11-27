import { z } from "zod";
import { MAX_SQL_TEXT } from "@/lib/contracts/query";
import type { CaseContent } from "./case";

/**
 * A dataset (decision `datasets-first-class`): a named set of rows that many evals can use. Rows are
 * trace turns first. A `fixed` dataset holds its rows: each one is a copy of a trace turn or values
 * that a person typed, and the newest version of each row counts at once (decision
 * `rows-count-at-once`). The other kinds are queries: a run resolves them when it starts and keeps
 * the rows that it got, so a later run of the same query can get other rows.
 *
 * - `last_traces`: the turns of the newest `limit` traces.
 * - `task_traces`: the newest `limit` turns of one task.
 * - `rql`: the turns of the traces that an RQL query gives (its `trace_id` column).
 * - `choose` ("let Ratel choose"): failed or low-score turns first, newest first, then a spread
 *   over the tasks (`choose.ts`).
 */

export const DATASET_KINDS = ["fixed", "last_traces", "task_traces", "rql", "choose"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];
export const QUERY_KINDS = ["last_traces", "task_traces", "rql", "choose"] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/** The rows of a resolved set when the dataset gives no limit. */
export const DEFAULT_ROW_LIMIT = 50;
/** The most rows of one run: of a resolved set, and of a fixed dataset. */
export const MAX_ROW_LIMIT = 500;
export const MAX_DATASET_NAME_CHARS = 100;
const MAX_TASK_ID_CHARS = 200;
/** The window of an RQL dataset, in days. RQL reads at most 30 days. */
export const DEFAULT_RQL_DAYS = 7;
export const MAX_RQL_DAYS = 30;

const limit = z
  .number()
  .int()
  .min(1, "a dataset has at least 1 row")
  .max(MAX_ROW_LIMIT, `a dataset has at most ${MAX_ROW_LIMIT} rows`)
  .default(DEFAULT_ROW_LIMIT);
const taskId = z.string().trim().min(1, "choose a task").max(MAX_TASK_ID_CHARS);

/** The settings of each kind. A fixed dataset has none: it has rows. */
export const datasetSettingsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed") }),
  z.object({ kind: z.literal("last_traces"), limit }),
  z.object({ kind: z.literal("task_traces"), taskId, limit }),
  z.object({
    kind: z.literal("rql"),
    text: z.string().trim().min(1, "write the RQL query").max(MAX_SQL_TEXT),
    days: z.number().int().min(1).max(MAX_RQL_DAYS).default(DEFAULT_RQL_DAYS),
    limit,
  }),
  z.object({ kind: z.literal("choose"), taskId: taskId.nullable().default(null), limit }),
]);
export type DatasetDefinition = z.output<typeof datasetSettingsSchema>;
/** What the `settings` column holds: the settings without the kind. */
export type DatasetSettings = Omit<DatasetDefinition, "kind">;

export const datasetDetailsSchema = z.object({
  name: z.string().trim().min(1, "give the dataset a name").max(MAX_DATASET_NAME_CHARS),
});

export type Dataset = {
  id: string;
  projectId: string;
  name: string;
  definition: DatasetDefinition;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The dataset as a run keeps it: what it was when the run started. */
export type FrozenDataset = {
  datasetId: string;
  name: string;
  kind: DatasetKind;
  settings: DatasetSettings;
  /** The rows that the run got from the dataset (resolved or fixed), before extra rows. */
  rows: number;
  resolvedAt: string;
};

/** A row that a run resolved, or that it adds for itself: the content and where it came from. */
export type ResolvedRow = {
  name: string;
  content: CaseContent;
  /** The turn that the row is a copy of. Null for typed values. */
  sourceTurnId: string | null;
  sourceOutput: string | null;
};

export function isQueryKind(kind: DatasetKind): kind is QueryKind {
  return kind !== "fixed";
}

/** The definition from the two columns. */
export function definitionOf(kind: DatasetKind, settings: DatasetSettings): DatasetDefinition {
  const parsed = datasetSettingsSchema.safeParse({ ...settings, kind });
  if (!parsed.success) throw new Error(`the settings of a ${kind} dataset are not readable`);
  return parsed.data;
}

/** The columns of a definition. */
export function columnsOf({ kind, ...settings }: DatasetDefinition): {
  kind: DatasetKind;
  settings: DatasetSettings;
} {
  return { kind, settings };
}

/** The rows of the resolved set that a run asks for: the limit of the kind. */
export function rowLimit(definition: DatasetDefinition): number {
  return definition.kind === "fixed" ? MAX_ROW_LIMIT : definition.limit;
}

/** Why a set of `count` rows cannot run, or null. */
export function tooManyRows(count: number, max: number = MAX_ROW_LIMIT): string | null {
  return count > max
    ? `The dataset gives ${count} rows. A run takes at most ${max} rows. Make the dataset smaller.`
    : null;
}

/** A short text of what a query dataset reads, for a list. Null for a fixed dataset. */
export function querySummary(definition: DatasetDefinition): string | null {
  switch (definition.kind) {
    case "fixed":
      return null;
    case "last_traces":
      return `The newest ${definition.limit} traces`;
    case "task_traces":
      return `The newest ${definition.limit} turns of the task ${definition.taskId}`;
    case "rql":
      return definition.text;
    case "choose":
      return definition.taskId
        ? `Ratel chooses ${definition.limit} turns of the task ${definition.taskId}`
        : `Ratel chooses ${definition.limit} turns`;
  }
}
