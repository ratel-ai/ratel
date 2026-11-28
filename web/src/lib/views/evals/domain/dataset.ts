import { z } from "zod";
import { MAX_SQL_TEXT } from "@/lib/contracts/query";
import type { CaseContent, CaseVersion } from "./case";

/**
 * A dataset: a named set of rows that many evals can use (decision `datasets-first-class`). A
 * `fixed` dataset holds its rows. A query kind holds a query, and a run resolves it when it starts
 * and freezes the rows that it found: the last N traces, the traces of a task, an RQL query, or
 * "let Ratel choose". A row is a case (`case.ts`): a trace turn with a frozen copy of what a run
 * needs, or named typed values.
 */

export const DATASET_KINDS = ["fixed", "last_traces", "task_traces", "rql", "auto"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];
export const QUERY_KINDS: ReadonlySet<DatasetKind> = new Set([
  "last_traces",
  "task_traces",
  "rql",
  "auto",
]);

/** The rows that a query resolves, unless it says another number. */
export const DEFAULT_ROW_LIMIT = 50;
/** The most rows that a query can resolve. */
export const MAX_ROW_LIMIT = 500;
const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TASK_ID_CHARS = 200;
const MAX_VALUES = 50;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_ROW_LIMIT, `a dataset resolves at most ${MAX_ROW_LIMIT} rows`)
  .default(DEFAULT_ROW_LIMIT);
const taskIdSchema = z.string().trim().min(1).max(MAX_TASK_ID_CHARS);

/** The kind of a dataset and, for a query kind, its settings. */
export const datasetQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed") }),
  z.object({ kind: z.literal("last_traces"), limit: limitSchema }),
  z.object({ kind: z.literal("task_traces"), taskId: taskIdSchema, limit: limitSchema }),
  z.object({
    kind: z.literal("rql"),
    /** One RQL SELECT that gives a `trace_id` column. */
    text: z.string().trim().min(1, "write the query").max(MAX_SQL_TEXT),
    limit: limitSchema,
  }),
  z.object({
    kind: z.literal("auto"),
    /** Only the turns of this task. Null: each task. */
    taskId: taskIdSchema.nullable().default(null),
    limit: limitSchema,
  }),
]);
export type DatasetQuery = z.infer<typeof datasetQuerySchema>;
export type ResolvedQuery = Exclude<DatasetQuery, { kind: "fixed" }>;

export const datasetDetailsSchema = z.object({
  name: z.string().trim().min(1, "give the dataset a name").max(MAX_NAME_CHARS),
  description: z.string().trim().max(MAX_DESCRIPTION_CHARS).nullable().default(null),
});
export type DatasetDetails = z.infer<typeof datasetDetailsSchema>;

export type Dataset = DatasetDetails & {
  id: string;
  projectId: string;
  query: DatasetQuery;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

/** A row that a query resolved: a turn and the frozen copy of what a run of it needs. */
export type ResolvedRow = { turnId: string; content: CaseContent; sourceOutput: string | null };

/** A row of named typed values (JSON values), with what the agent should answer. */
export const valueRowSchema = z.object({
  values: z
    .record(z.string().regex(FIELD_NAME, "a name has letters, digits and _"), z.json())
    .refine((values) => Object.keys(values).length > 0, "give the row a value")
    .refine((values) => Object.keys(values).length <= MAX_VALUES, `at most ${MAX_VALUES} values`),
  expectedOutput: z.string().nullable().default(null),
});
export type ValueRow = z.infer<typeof valueRowSchema>;

/** The content of a case that holds a value row: the values are its input. */
export function valuesContent({ values, expectedOutput }: ValueRow): CaseContent {
  return { input: values, earlierTurns: [], toolFixtures: [], expectedOutput };
}

/** A row saved from a trace turn keeps the turn id. Any other row holds values. */
export function rowKindOf(version: Pick<CaseVersion, "sourceTurnId">): "trace" | "values" {
  return version.sourceTurnId === null ? "values" : "trace";
}

export function isQueryKind(query: DatasetQuery): query is ResolvedQuery {
  return QUERY_KINDS.has(query.kind);
}

/** A turn that "let Ratel choose" can take. */
export type ChoiceCandidate = {
  turnId: string;
  taskId: string | null;
  /** The turn failed, or a scorer gave it a low score. */
  failed: boolean;
  endedAt: Date;
};

/**
 * "Let Ratel choose" with no task selection: the newest failed or low-score turns first, then one
 * turn of each task in turn (the task with the newest turn first, the turns of no task as one more
 * task), newest first in each task.
 */
export function chooseSpread(candidates: readonly ChoiceCandidate[], limit: number): string[] {
  const newest = [...candidates].sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
  const chosen = newest.filter(({ failed }) => failed).map(({ turnId }) => turnId);
  const byTask = [
    ...Map.groupBy(
      newest.filter(({ failed }) => !failed),
      byTaskKey,
    ).values(),
  ];
  for (let index = 0; chosen.length < limit; index++) {
    const round = byTask.flatMap((turns) => turns[index] ?? []);
    if (round.length === 0) break;
    chosen.push(...round.map(({ turnId }) => turnId));
  }
  return chosen.slice(0, limit);
}

function byTaskKey({ taskId }: ChoiceCandidate): string {
  return taskId ?? "";
}
