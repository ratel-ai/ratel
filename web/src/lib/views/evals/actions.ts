import { z } from "zod";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import { type PreviewResult, previewDataset, resolveDataset } from "./datasets";
import {
  type Dataset,
  datasetDetailsSchema,
  datasetQuerySchema,
  isQueryKind,
  valueRowSchema,
} from "./domain/dataset";
import {
  type EvalDefinition,
  type EvalScorer,
  evalContentSchema,
  evalDetailsSchema,
  MAX_EVAL_TRIALS,
  matrixSchema,
  scorerRefSchema,
} from "./domain/eval";
import type { Experiment } from "./domain/experiment";
import type { CaseFromTurn } from "./domain/from-turn";
import { type EvalRunChanges, startEvalRun } from "./eval-runs";
import { MAX_PICKED_TURNS } from "./eval-form";
import type { ExperimentDeps, StartRefusal } from "./experiments";
import type { DatasetStore, NewRow } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import { scorerFromRef } from "./scorer-library";

/**
 * What a person does on the Datasets and Evals pages, and what an agent does with the same MCP
 * operations (AGENTS.md, Web and MCP parity): create a dataset, add and remove its rows, preview a
 * query, create and edit an eval with library scorers, and start a run with changes for that run
 * only. The session routes (`console-api.ts`) and the operations call these. The caller checks the
 * member or the key, the flag and the content rule; the project id comes from that check, never
 * from the body.
 */

export type ActionDeps = Omit<ExperimentDeps, "datasets" | "evals"> & {
  datasets: DatasetStore;
  evals: EvalStore;
  /** A row from a trace turn of the project. Null: no such turn, or no captured input. */
  turnRow(projectId: string, turnId: string): Promise<CaseFromTurn | null>;
};

export type Refused = { ok: false; reason: ActionRefusal; message: string };
export type ActionRefusal =
  | "invalid"
  | "not_found"
  | "name_taken"
  | "no_content_access"
  | "not_fixed"
  | "changed"
  | StartRefusal;

export type Done<T> = ({ ok: true } & T) | Refused;

/** The most rows of one request. */
export const MAX_ROWS = 100;

const paramValue = z.union([z.string(), z.number(), z.boolean()]);
const turnIdsSchema = z.array(z.uuid()).min(1).max(MAX_PICKED_TURNS);

export const rowInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), turnId: z.uuid(), name: z.string().trim().min(1).max(200).optional() }),
  valueRowSchema.extend({ kind: z.literal("values"), name: z.string().trim().min(1).max(200) }),
]);
export type RowInput = z.infer<typeof rowInputSchema>;

export const newDatasetSchema = datasetDetailsSchema.extend({
  query: datasetQuerySchema.default({ kind: "fixed" }),
  /** A fixed dataset from chosen trace turns. */
  turnIds: turnIdsSchema.optional(),
});

export const scorerBodySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  gating: z.boolean(),
  ref: scorerRefSchema,
});

const datasetChoiceSchema = z.union([
  z.object({ datasetId: z.uuid() }),
  z.object({ query: datasetQuerySchema.refine(isQueryKind, "a query, not fixed rows") }),
]);

export const evalBodySchema = evalDetailsSchema.extend({
  sandboxName: z.string().trim().min(1).max(200),
  sandboxVersionId: z.uuid().nullable().default(null),
  dataset: datasetChoiceSchema,
  params: z.record(z.string(), paramValue).default({}),
  matrix: matrixSchema,
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS),
  scorers: z.array(scorerBodySchema).min(1).max(50),
});
export type EvalBody = z.infer<typeof evalBodySchema>;

export const runBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  dataset: z.uuid().optional(),
  rows: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("turns"), turnIds: turnIdsSchema }),
      z.object({
        kind: z.enum(["last_traces", "auto"]),
        limit: datasetQuerySchema.options[1].shape.limit,
      }),
    ])
    .optional(),
  scorers: z.array(scorerBodySchema).min(1).max(50).optional(),
  sandboxVersion: z.union([z.literal("latest"), z.uuid()]).optional(),
  params: z.record(z.string(), paramValue).optional(),
  matrix: matrixSchema.optional(),
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS).optional(),
});
export type RunBody = z.infer<typeof runBodySchema>;

/** Who acts, and whether they may read captured text (a row from a turn copies it). */
export type Actor = { by: string; mayReadContent: boolean };

export async function createDataset(
  projectId: string,
  actor: Actor,
  input: z.output<typeof newDatasetSchema>,
  deps: ActionDeps,
): Promise<Done<{ dataset: Dataset; rows: number }>> {
  const { turnIds, query, ...details } = input;
  if (turnIds && query.kind !== "fixed") {
    return refused("invalid", "A query dataset holds no row. A run resolves it.");
  }
  const rows = turnIds
    ? await rowsOf(
        projectId,
        actor,
        turnIds.map((turnId) => ({ kind: "turn" as const, turnId })),
        deps,
      )
    : null;
  if (rows && !rows.ok) return rows;
  const made = await deps.datasets.create({ projectId, ...details, query, createdBy: actor.by });
  if (made === "name_taken") return refused("name_taken", "Another dataset of the project has this name.");
  if (rows) await deps.datasets.addRows(projectId, made.id, rows.rows, actor.by);
  return { ok: true, dataset: made, rows: rows?.rows.length ?? 0 };
}

export async function addDatasetRows(
  projectId: string,
  datasetId: string,
  actor: Actor,
  rows: readonly RowInput[],
  deps: ActionDeps,
): Promise<Done<{ rows: Array<{ rowId: string; name: string }> }>> {
  const made = await rowsOf(projectId, actor, rows, deps);
  if (!made.ok) return made;
  const added = await deps.datasets.addRows(projectId, datasetId, made.rows, actor.by);
  if (added === "not_found") return refused("not_found", "There is no such dataset.");
  if (added === "not_fixed") {
    return refused("not_fixed", "A query dataset holds no row. A run resolves it.");
  }
  return { ok: true, rows: added.map(({ id, name }) => ({ rowId: id, name })) };
}

export async function removeDatasetRow(
  projectId: string,
  datasetId: string,
  rowId: string,
  deps: Pick<ActionDeps, "datasets" | "now">,
): Promise<Done<object>> {
  const removed = await deps.datasets.removeRow(projectId, datasetId, rowId, deps.now());
  if (removed === "not_found") return refused("not_found", "There is no such row in the dataset.");
  if (removed === "not_fixed") {
    return refused("not_fixed", "A query dataset holds no row. A run resolves it.");
  }
  return { ok: true };
}

/** What a query resolves to now. Nothing is frozen. The content rule is the one of a run. */
export async function previewQuery(
  projectId: string,
  actor: Actor,
  query: z.output<typeof datasetQuerySchema>,
  deps: Pick<ActionDeps, "traces">,
): Promise<PreviewResult> {
  if (!actor.mayReadContent) {
    return {
      ok: false,
      reason: "no_content_access",
      message: "Captured text is not readable here, so the preview shows no row.",
    };
  }
  return previewDataset(projectId, query, deps.traces);
}

export async function createEval(
  projectId: string,
  actor: Actor,
  body: EvalBody,
  deps: ActionDeps,
): Promise<Done<{ eval: EvalDefinition }>> {
  if (await deps.evals.getByName(projectId, body.name)) {
    return refused("name_taken", "Another eval of the project has this name.");
  }
  const content = await contentOf(projectId, actor, body, deps);
  if (!content.ok) return content;
  const made = await deps.evals.create({
    projectId,
    name: body.name,
    taskId: body.taskId,
    content: content.content,
    createdBy: actor.by,
  });
  if (made === "name_taken") return refused("name_taken", "Another eval of the project has this name.");
  if (made === "dataset_not_found") return refused("not_found", "There is no such dataset.");
  return { ok: true, eval: made };
}

/** An edit adds a version when the content changes. `base` is the version that the person read. */
export async function editEval(
  projectId: string,
  evalId: string,
  actor: Actor & { now: Date },
  body: EvalBody & { base: string },
  deps: ActionDeps,
): Promise<Done<{ eval: EvalDefinition }>> {
  const found = await deps.evals.get(projectId, evalId);
  if (!found) return refused("not_found", "There is no such eval.");
  const content = await contentOf(projectId, actor, body, deps);
  if (!content.ok) return content;
  const saved = await deps.evals.update(
    projectId,
    evalId,
    { name: body.name, taskId: body.taskId, content: content.content },
    body.base,
    { userId: actor.by, now: actor.now },
  );
  if (saved === "not_found") return refused("not_found", "There is no such eval.");
  if (saved === "changed") return refused("changed", "Another person changed this eval. Read it again.");
  if (saved === "name_taken") return refused("name_taken", "Another eval of the project has this name.");
  if (saved === "dataset_not_found") return refused("not_found", "There is no such dataset.");
  return { ok: true, eval: saved };
}

/** A run of one eval of the project, with the changes of the body for this run only. */
export async function startRun(
  subject: UsageSubject,
  evalId: string,
  actor: Actor,
  body: RunBody,
  deps: ActionDeps,
): Promise<Done<{ experiment: Experiment }>> {
  const definition = await deps.evals.get(subject.projectId, evalId);
  if (!definition) return refused("not_found", "There is no such eval.");
  const changes = await runChanges(subject.projectId, actor, body, deps);
  if (!changes.ok) return changes;
  const started = await startEvalRun(
    subject,
    {
      eval: definition.id,
      startedBy: actor.by,
      ...(body.name ? { name: body.name } : {}),
      changes: changes.changes,
    },
    deps,
  );
  return started.ok ? { ok: true, experiment: started.experiment } : started;
}

/**
 * The changes of one run from a request: rows from chosen turns or from a query resolved now (they
 * are rows of this run only), and library scorers with the definitions that they have now.
 */
export async function runChanges(
  projectId: string,
  actor: Actor,
  body: Omit<RunBody, "name">,
  deps: ActionDeps,
): Promise<Done<{ changes: EvalRunChanges }>> {
  const { rows: asked, scorers: askedScorers, ...rest } = body;
  const changes: EvalRunChanges = { ...rest };
  if (asked) {
    const rows =
      asked.kind === "turns"
        ? await rowsOf(
            projectId,
            actor,
            asked.turnIds.map((turnId) => ({ kind: "turn" as const, turnId })),
            deps,
          )
        : await queryRows(projectId, actor, asked, deps);
    if (!rows.ok) return rows;
    changes.rows = rows.rows;
  }
  if (askedScorers) {
    const scorers = await withDefinitions(projectId, askedScorers, deps);
    if (!scorers.ok) return scorers;
    changes.scorers = scorers.scorers;
  }
  return { ok: true, changes };
}

/** The dataset of an eval: one of the project, or a new one from a query, named after the eval. */
export async function datasetFor(
  projectId: string,
  actor: Actor,
  choice: { datasetId: string } | { query: z.output<typeof datasetQuerySchema> },
  evalName: string,
  deps: ActionDeps,
): Promise<Done<{ datasetId: string }>> {
  if ("datasetId" in choice) {
    const found = await deps.datasets.get(projectId, choice.datasetId);
    return found ? { ok: true, datasetId: found.id } : refused("not_found", "There is no such dataset.");
  }
  const made = await createDataset(
    projectId,
    actor,
    { name: await freeDatasetName(projectId, evalName, deps), description: null, query: choice.query },
    deps,
  );
  return made.ok ? { ok: true, datasetId: made.dataset.id } : made;
}

async function contentOf(
  projectId: string,
  actor: Actor,
  body: EvalBody,
  deps: ActionDeps,
) {
  const scorers = await withDefinitions(projectId, body.scorers, deps);
  if (!scorers.ok) return scorers;
  const dataset = await datasetFor(projectId, actor, body.dataset, body.name, deps);
  if (!dataset.ok) return dataset;
  const { datasetId } = dataset;
  const content = evalContentSchema.safeParse({
    datasetId,
    sandboxName: body.sandboxName,
    sandboxVersionId: body.sandboxVersionId,
    params: body.params,
    matrix: body.matrix,
    trials: body.trials,
    scorers: scorers.scorers,
  });
  if (!content.success) {
    return refused("invalid", content.error.issues[0]?.message ?? "The eval is not valid.");
  }
  return { ok: true as const, content: content.data };
}

/** A name that no dataset of the project has: the eval name, then "(2)", "(3)". */
async function freeDatasetName(projectId: string, name: string, deps: Pick<ActionDeps, "datasets">) {
  const taken = new Set((await deps.datasets.list(projectId)).map((one) => one.name));
  let free = name;
  for (let n = 2; taken.has(free); n++) free = `${name} (${n})`.slice(0, 100);
  return free;
}

export async function withDefinitions(
  projectId: string,
  scorers: ReadonlyArray<z.output<typeof scorerBodySchema>>,
  deps: Pick<ActionDeps, "library">,
): Promise<Done<{ scorers: EvalScorer[] }>> {
  const made: EvalScorer[] = [];
  for (const scorer of scorers) {
    const found = await scorerFromRef(projectId, scorer, deps.library);
    if (!found.ok) return refused("invalid_scorers", found.message);
    made.push(found.scorer);
  }
  return { ok: true, scorers: made };
}

/** Rows from turns (captured text: the caller must may read it) and typed values. */
async function rowsOf(
  projectId: string,
  actor: Actor,
  rows: readonly RowInput[],
  deps: Pick<ActionDeps, "turnRow">,
): Promise<Done<{ rows: NewRow[] }>> {
  if (rows.length > MAX_ROWS) return refused("invalid", `At most ${MAX_ROWS} rows at a time.`);
  const made: NewRow[] = [];
  for (const row of rows) {
    if (row.kind === "values") {
      const { values, expectedOutput, name } = row;
      made.push({ kind: "values", name, row: { values, expectedOutput } });
      continue;
    }
    if (!actor.mayReadContent) {
      return refused(
        "no_content_access",
        "A row from a trace copies captured text, which is not readable here.",
      );
    }
    const found = await deps.turnRow(projectId, row.turnId);
    if (!found) {
      return refused(
        "not_found",
        `The turn ${row.turnId} is not in the project, or it has no captured input.`,
      );
    }
    made.push({
      kind: "trace",
      name: row.name ?? `Turn ${row.turnId.slice(0, 8)}`,
      turnId: row.turnId,
      content: found.content,
      sourceOutput: found.sourceOutput,
    });
  }
  return { ok: true, rows: made };
}

/** The rows that "the last N traces" or "let Ratel choose" finds now, for one run. */
async function queryRows(
  projectId: string,
  actor: Actor,
  { kind, limit }: { kind: "last_traces" | "auto"; limit: number },
  deps: Pick<ActionDeps, "traces">,
): Promise<Done<{ rows: NewRow[] }>> {
  if (!actor.mayReadContent) {
    return refused(
      "no_content_access",
      "A row from a trace copies captured text, which is not readable here.",
    );
  }
  const query = kind === "auto" ? { kind, limit, taskId: null } : { kind, limit };
  const resolved = await resolveDataset(projectId, query, deps.traces);
  if (!resolved.ok) {
    const reason =
      resolved.reason === "no_rows"
        ? "no_cases"
        : resolved.reason === "not_a_query"
          ? "invalid"
          : resolved.reason;
    return refused(reason, resolved.message);
  }
  return {
    ok: true,
    rows: resolved.rows.map(({ turnId, content, sourceOutput }) => ({
      kind: "trace",
      name: `Turn ${turnId.slice(0, 8)}`,
      turnId,
      content,
      sourceOutput,
    })),
  };
}

function refused(reason: ActionRefusal, message: string): Refused {
  return { ok: false, reason, message };
}
