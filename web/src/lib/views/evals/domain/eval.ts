import { z } from "zod";
import {
  CHECK_OPERATORS,
  isComparable,
  isTrialCheckPath,
  MAX_PATH_CHARS,
  MAX_VALUE_CHARS,
} from "@/lib/contracts/check";
import type { ScorerDefinition } from "@/lib/views/scorers/types";
import { type Matrix, matrixSchema } from "./matrix";
import { PREDEFINED_KEYS, predefinedScorer } from "./predefined-scorers";

/**
 * An eval: a name, the task it checks (by id only), and its versions. A version is a small record
 * of references: one dataset (`dataset.ts`), one runtime (a sandbox, and its newest ready version or
 * a pinned one), the scorers of the library (`scorer-library.ts`), the trials of each row, the
 * default params and a matrix (`matrix.ts`). A version never changes: an edit adds a new one, so a
 * run freezes the version that is newest when it starts.
 */

export const MAX_EVAL_NAME_CHARS = 100;
const MAX_TASK_ID_CHARS = 200;
export const MAX_SANDBOX_NAME_CHARS = 200;
const MAX_QUESTION_CHARS = 5_000;
const MAX_SCORERS = 50;
/** The judges of a trial run at the same time, and each one costs a call. */
export const MAX_JUDGES = 5;
export const DEFAULT_EVAL_TRIALS = 3;
export const MAX_EVAL_TRIALS = 20;
const MAX_PARAMS_CHARS = 16 * 1024;

const checkSchema = z
  .object({
    path: z.string().trim().max(MAX_PATH_CHARS).refine(isTrialCheckPath, "choose what to read"),
    op: z.enum(CHECK_OPERATORS),
    value: z.union([z.string().min(1).max(MAX_VALUE_CHARS), z.number(), z.boolean()]).optional(),
  })
  .refine(({ op, value }) => op === "exists" || value !== undefined, {
    message: "give the check a value to compare with",
  })
  .refine(({ op, value }) => value === undefined || isComparable(op, value), {
    message: "this operator compares with a number",
  });

/** A judge of evals answers yes or no. */
const judgeSchema = z.object({
  prompt: z.string().trim().min(1, "write the question").max(MAX_QUESTION_CHARS),
  output: z.literal("boolean"),
});

const definitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), config: checkSchema }),
  z.object({ kind: z.literal("judge"), config: judgeSchema }),
]) satisfies z.ZodType<ScorerDefinition>;

/** A scorer of an eval: the shared definition, and whether it decides the result of a trial. */
export const evalScorerSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  gating: z.boolean(),
  definition: definitionSchema,
});
export type EvalScorer = z.infer<typeof evalScorerSchema>;

/** A scorer of the project (`views/scorers`), by its id. */
const projectRefSchema = z.object({
  source: z.literal("project"),
  scorerId: z.uuid(),
  gating: z.boolean().default(true),
});

/** A pre-defined scorer (`predefined-scorers.ts`), with its setting when it needs one. */
const predefinedRefSchema = z.object({
  source: z.literal("predefined"),
  key: z.enum(PREDEFINED_KEYS),
  gating: z.boolean().default(true),
  value: z.union([z.string().trim().min(1).max(MAX_VALUE_CHARS), z.number().min(0)]).optional(),
});

/** An eval's own scorer: the scorers of an eval from before the library, shown as "from this eval". */
const ownScorerSchema = evalScorerSchema.extend({ source: z.literal("eval").optional() });

/** A scorer of an eval: a reference to the library, or a scorer of its own. */
export const evalScorerRefSchema = z.union([
  projectRefSchema,
  predefinedRefSchema,
  ownScorerSchema,
]);
export type EvalScorerRef = z.infer<typeof evalScorerRefSchema>;

/**
 * The id of a scorer reference: `project:<id>`, `predefined:<key>[:<setting>]`, or the id of an own
 * scorer. A run gives the frozen scorer this id, so a trial result pairs with its reference.
 */
export function refIdOf(ref: EvalScorerRef): string {
  if (ref.source === "project") return `project:${ref.scorerId}`;
  if (ref.source === "predefined") {
    return ref.value === undefined ? `predefined:${ref.key}` : `predefined:${ref.key}:${ref.value}`;
  }
  return ref.id;
}

/** A judge that the reference is, as far as the eval knows. A project scorer is checked at the run. */
function isJudge(ref: EvalScorerRef): boolean {
  if (ref.source === "project") return false;
  if (ref.source === "predefined") return predefinedScorer(ref.key)?.kind === "judge";
  return ref.definition.kind === "judge";
}

export const evalScorersSchema = z
  .array(evalScorerRefSchema)
  .max(MAX_SCORERS)
  .refine(
    (scorers) => new Set(scorers.map(refIdOf)).size === scorers.length,
    "two scorers have the same id",
  )
  .refine(
    (scorers) => scorers.filter(isJudge).length <= MAX_JUDGES,
    `an eval has at most ${MAX_JUDGES} judges`,
  );

/** What a version of an eval freezes. */
export const evalContentSchema = z.object({
  /**
   * The dataset of the eval. Null when an eval is created: the store makes a fixed dataset with the
   * name of the eval. Null in an edit: the dataset does not change.
   */
  datasetId: z.uuid().nullable().default(null),
  /** The sandbox that runs the eval (the runtime). Null: the sandbox of the run. */
  sandboxName: z.string().trim().min(1).max(MAX_SANDBOX_NAME_CHARS).nullable().default(null),
  /** A pinned version of the sandbox. Null: its newest ready version when a run starts. */
  sandboxVersionId: z.uuid().nullable().default(null),
  /** The params of a run, unless the run gives its own. */
  params: z
    .record(z.string(), z.unknown())
    .refine(
      (params) => JSON.stringify(params).length <= MAX_PARAMS_CHARS,
      "the params are too large",
    )
    .default({}),
  /** For some params, a list of values: a run has one variant for each combination. */
  matrix: matrixSchema,
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS).default(DEFAULT_EVAL_TRIALS),
  scorers: evalScorersSchema.default([]),
});
export type EvalContent = z.infer<typeof evalContentSchema>;

export const evalDetailsSchema = z.object({
  name: z.string().trim().min(1, "give the eval a name").max(MAX_EVAL_NAME_CHARS),
  /** The task that the eval checks. Null: no task. */
  taskId: z.string().trim().min(1).max(MAX_TASK_ID_CHARS).nullable().default(null),
});
export type EvalDetails = z.infer<typeof evalDetailsSchema>;

export type EvalVersion = Omit<EvalContent, "matrix"> & {
  matrix: Matrix;
  id: string;
  evalId: string;
  number: number;
  createdBy: string;
  createdAt: Date;
};

export type EvalDefinition = EvalDetails & {
  id: string;
  projectId: string;
  createdAt: Date;
  /** The newest first. There is always one. */
  versions: EvalVersion[];
};

/** An eval version as a run freezes it, with the params and the trials that the run used. */
export type FrozenEval = {
  evalId: string;
  versionId: string;
  number: number;
  name: string;
  /** The default params of the eval with the params of the run over them. */
  params: Record<string, unknown>;
  trials: number;
  /** The matrix that the run used. Absent for a run from before matrices. */
  matrix?: Matrix;
};

/** The version that a run uses: the newest one. */
export function currentVersion(definition: Pick<EvalDefinition, "versions">): EvalVersion {
  const [newest] = definition.versions;
  if (!newest) throw new Error("the eval has no version");
  return newest;
}

/** Why the eval cannot run, or null. With no gating scorer each trial would pass. */
export function runProblem(content: Pick<EvalContent, "scorers">): string | null {
  return content.scorers.some(({ gating }) => gating)
    ? null
    : "Give the eval at least one gating scorer.";
}

/** The run's params go over the eval's. The run's trials, when it gives them, replace the eval's. */
export function freezeEval(
  definition: EvalDefinition,
  run: { params?: Record<string, unknown>; trials?: number } = {},
): FrozenEval {
  const { id, number, params, trials } = currentVersion(definition);
  return {
    evalId: definition.id,
    versionId: id,
    number,
    name: definition.name,
    params: { ...params, ...run.params },
    trials: run.trials ?? trials,
  };
}

/** Whether an edit changes what a version freezes. The order of the keys of an object does not count. */
export function sameContent(a: EvalContent, b: EvalContent): boolean {
  return canonical(contentOf(a)) === canonical(contentOf(b));
}

function contentOf(content: EvalContent): EvalContent {
  const { datasetId, sandboxName, sandboxVersionId, params, matrix, trials, scorers } = content;
  return { datasetId, sandboxName, sandboxVersionId, params, matrix, trials, scorers };
}

/** JSON with the keys of each object in order: Postgres stores jsonb keys in its own order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item === null || typeof item !== "object" || Array.isArray(item)
      ? item
      : Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/** The eval's own scorers (from before the library), as the console editor edits them. */
export function ownScorers(refs: readonly EvalScorerRef[]): EvalScorer[] {
  return refs.flatMap((ref) => {
    if (ref.source === "project" || ref.source === "predefined") return [];
    const { source: _, ...own } = ref;
    return [own];
  });
}

/** The references to the library: what the console editor of own scorers keeps as it is. */
export function libraryRefs(refs: readonly EvalScorerRef[]): EvalScorerRef[] {
  return refs.filter((ref) => ref.source === "project" || ref.source === "predefined");
}
