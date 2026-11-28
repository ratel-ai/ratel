import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { defaultContentAccessDeps, mayReadContent } from "@/lib/mcp/operations/content-access";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows } from "@/lib/mcp/serialize";
import { getDb } from "@/lib/platform/db/client";
import { storable } from "@/lib/platform/storable";
import { previewQuery, removeDatasetRow } from "@/lib/views/evals/actions";
import { createDrizzleBaselineStore } from "@/lib/views/evals/adapters/drizzle-baseline-store";
import { createDrizzleDatasetStore } from "@/lib/views/evals/adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { createTraceSource } from "@/lib/views/evals/adapters/trace-source";
import type { Compared } from "@/lib/views/evals/baseline";
import { readOnlyTools } from "@/lib/views/evals/console-deps";
import { currentVersion as currentRow } from "@/lib/views/evals/domain/case";
import {
  DATASET_KINDS,
  DEFAULT_ROW_LIMIT,
  datasetQuerySchema,
  MAX_ROW_LIMIT,
  rowKindOf,
  valueRowSchema,
} from "@/lib/views/evals/domain/dataset";
import { caseFromTurn } from "@/lib/views/evals/domain/from-turn";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { datasetsView, evalHistory, withPinnedRuns } from "@/lib/views/evals/history-view";
import type { DatasetStore, NewRow } from "@/lib/views/evals/ports/dataset-store";
import type { EvalStore } from "@/lib/views/evals/ports/eval-store";
import type { ScorerLibrary } from "@/lib/views/evals/ports/scorer-library";
import type { TraceSource } from "@/lib/views/evals/ports/trace-source";
import { rowOfSandboxRun } from "@/lib/views/evals/sandbox-rows";
import { listScorerLibrary } from "@/lib/views/evals/scorer-library";
import { loadTurnContent } from "@/lib/views/evals/turn-content";
import { getRun, type SandboxRun } from "@/lib/views/sandboxes";
import { listScorers } from "@/lib/views/scorers/store";

/**
 * Datasets, the scorer library and the score history over MCP (decisions `datasets-first-class`,
 * `scorer-library`, `runs-per-eval`, `mcp-surface`), behind the `evals` flag. The words follow the
 * decision `eval-terms`: dataset, scorer, eval, run.
 */
export interface EvalDatasetsDeps {
  enabled(projectId: string): Promise<boolean>;
  datasets(): DatasetStore;
  evals(): EvalStore;
  library(): ScorerLibrary;
  /** The newest runs of the project with their trials. */
  runs(projectId: string, limit: number): Promise<Compared[]>;
  /** One run with its trials. */
  run(projectId: string, experimentId: string): Promise<Compared | null>;
  baselineOf(projectId: string, evalId: string): Promise<string | null>;
  /** A row from a turn. Null when the turn is not there or has no input. Captured text. */
  turnRow(
    projectId: string,
    turnId: string,
  ): Promise<{ content: NewRowContent; sourceOutput: string | null } | null>;
  getSandboxRun(projectId: string, runId: string): Promise<SandboxRun | null>;
  mayReadContent(ctx: Pick<OperationContext, "auth" | "projectId">): Promise<boolean>;
  /** The traces, tasks and RQL that a query dataset reads. */
  traces(): TraceSource;
  now(): Date;
}

type NewRowContent = Extract<NewRow, { kind: "trace" }>["content"];

const ROWS_SHOWN = 100;
const HISTORY_RUNS = 100;
const INPUT_CHARS = 1_000;

const defaultDeps: EvalDatasetsDeps = {
  enabled: (projectId) => evalsEnabledForProject(projectId),
  datasets: () => createDrizzleDatasetStore(getDb()),
  evals: () => createDrizzleEvalStore(getDb()),
  library: () => ({ projectScorers: (projectId) => listScorers(projectId) }),
  runs: async (projectId, limit) => {
    const experiments = createDrizzleExperimentStore(getDb());
    const list = await experiments.list(projectId, limit);
    return Promise.all(
      list.map(async (experiment) => ({
        experiment,
        trials: await experiments.trials(experiment.id),
      })),
    );
  },
  run: async (projectId, experimentId) => {
    const experiments = createDrizzleExperimentStore(getDb());
    const experiment = await experiments.get(projectId, experimentId);
    return experiment ? { experiment, trials: await experiments.trials(experiment.id) } : null;
  },
  baselineOf: async (projectId, evalId) =>
    (await createDrizzleBaselineStore(getDb()).get(projectId, evalId))?.experimentId ?? null,
  turnRow: async (projectId, turnId) => {
    const turn = await loadTurnContent(projectId, turnId);
    const made = turn && caseFromTurn(turn, await readOnlyTools(projectId));
    return made ? { content: made.content, sourceOutput: made.sourceOutput } : null;
  },
  getSandboxRun: getRun,
  mayReadContent: (ctx) => mayReadContent(ctx, defaultContentAccessDeps),
  traces: () => createTraceSource(getDb(), { readOnlyTools, now: () => new Date() }),
  now: () => new Date(),
};

const datasetParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The name or the id of a dataset. evals_list_datasets gives them.");

export function evalDatasetsOperations(deps: EvalDatasetsDeps = defaultDeps): McpOperation[] {
  return [
    defineOperation({
      id: "evals_list_datasets",
      domain: "evals",
      title: "List datasets",
      description:
        "Use this tool to see the datasets of the project. A dataset is a set of inputs for an eval. It returns each dataset with its id, name and kind, the number of rows or the query, the time of the last change, and the evals that use it.",
      keywords: ["evals", "datasets", "rows"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const [summaries, evals] = await Promise.all([
          deps.datasets().list(ctx.projectId),
          deps.evals().list(ctx.projectId),
        ]);
        return {
          data: { datasets: datasetsView(summaries, evals) },
          hint:
            summaries.length === 0
              ? "No dataset yet. Call evals_create_dataset."
              : "Call evals_get_dataset with a dataset name for its rows.",
        };
      },
    }),
    defineOperation({
      id: "evals_get_dataset",
      domain: "evals",
      title: "Read a dataset",
      description:
        "Use this tool to read one dataset by its name or id. It returns its kind and its query, and each row with its id, name, kind (trace or values), turn id and version number. A row shows its input only when the key and the project allow captured text.",
      keywords: ["evals", "dataset", "rows"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped, dataset: datasetParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const dataset = await findDataset(deps, ctx.projectId, params.dataset);
        if (!dataset) throw notFound("dataset");
        const [rows, readable] = await Promise.all([
          deps.datasets().rows(ctx.projectId, dataset.id),
          deps.mayReadContent(ctx),
        ]);
        const read = capRows(rows, ROWS_SHOWN);
        return {
          data: {
            datasetId: dataset.id,
            name: dataset.name,
            description: dataset.description,
            query: dataset.query,
            rows: read.rows.map((row) => {
              const version = currentRow(row);
              return {
                rowId: row.id,
                name: row.name,
                labels: row.labels,
                kind: version ? rowKindOf(version) : "values",
                turnId: version?.sourceTurnId ?? null,
                version: version?.number ?? null,
                input: readable && version ? shortJson(version.input) : null,
              };
            }),
            ...(readable ? {} : { contentWithheld: true }),
          },
          ...(read.truncated ? { truncated: true } : {}),
          hint:
            dataset.query.kind === "fixed"
              ? "Call evals_add_dataset_row to add a trace turn, a sandbox run or typed values."
              : "A run resolves the query of this dataset when it starts, and keeps the rows that it found.",
        };
      },
    }),
    defineOperation({
      id: "evals_create_dataset",
      domain: "evals",
      title: "Create a dataset",
      description:
        "Use this tool to create a dataset. This tool changes data. Kind fixed holds rows. Kind last_traces, task_traces, rql or auto holds a query that each run resolves. It returns the dataset id, its name and its kind.",
      keywords: ["evals", "new dataset", "rql dataset"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        name: z.string().trim().min(1).max(100).describe("The name of the dataset."),
        description: z.string().trim().max(2_000).optional(),
        kind: z
          .enum(DATASET_KINDS)
          .default("fixed")
          .describe(
            "fixed: saved rows. last_traces: the last N traces. task_traces: the traces of a task. rql: the traces that an RQL query gives (a trace_id column). auto: Ratel chooses.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROW_LIMIT)
          .optional()
          .describe(
            `The most rows that a query resolves. Default: ${DEFAULT_ROW_LIMIT}. The most: ${MAX_ROW_LIMIT}.`,
          ),
        taskId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The task of task_traces or auto."),
        text: z.string().trim().min(1).max(20_000).optional().describe("The RQL text of kind rql."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const { kind, limit, taskId, text } = params;
        const query = datasetQuerySchema.safeParse({
          kind,
          ...(limit === undefined ? {} : { limit }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(text === undefined ? {} : { text }),
        });
        if (!query.success) {
          const issue = query.error.issues[0];
          throw invalidParams(issue?.message ?? "The query is not valid.", [
            { path: String(issue?.path[0] ?? "kind"), message: issue?.message ?? "Not valid." },
          ]);
        }
        const made = await deps.datasets().create({
          projectId: ctx.projectId,
          name: params.name,
          description: params.description ?? null,
          query: query.data,
          createdBy: requester(ctx.auth),
        });
        if (made === "name_taken") {
          throw new McpOperationError("conflict", "Another dataset of the project has this name.", {
            reason: "name_taken",
          });
        }
        return {
          data: { datasetId: made.id, name: made.name, kind: made.query.kind },
          hint:
            made.query.kind === "fixed"
              ? "Call evals_add_dataset_row to add rows. Then give the dataset to an eval with evals_create."
              : "Give the dataset to an eval with evals_create. Each run resolves its query.",
        };
      },
    }),
    defineOperation({
      id: "evals_add_dataset_row",
      domain: "evals",
      title: "Add a row to a dataset",
      description:
        "Use this tool to add one row to a fixed dataset: a trace turn (turnId), a sandbox run of the Playground (sandboxRunId), or typed values. This tool changes data. The row counts at once. It returns the row id and its name.",
      keywords: ["evals", "dataset row", "trace to eval", "playground run"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        dataset: datasetParam,
        name: z.string().trim().min(1).max(200).optional().describe("A short name of the row."),
        turnId: uuidParam()
          .optional()
          .describe("A trace turn to copy: its input and its tool fixtures."),
        sandboxRunId: uuidParam().optional().describe("A Playground run to copy: its input."),
        values: z
          .record(z.string(), z.json())
          .optional()
          .describe("Named typed values. They are the input of the row."),
        expectedOutput: z.string().max(20_000).optional().describe("The correct answer, as text."),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const dataset = await findDataset(deps, ctx.projectId, params.dataset);
        if (!dataset) throw notFound("dataset");
        const row = await rowOf(deps, ctx, params);
        const added = await deps
          .datasets()
          .addRows(ctx.projectId, dataset.id, [row], requester(ctx.auth));
        if (added === "not_found") throw notFound("dataset");
        if (added === "not_fixed") {
          throw new McpOperationError(
            "conflict",
            "The dataset is a query: a run resolves its rows. Add the row to a fixed dataset.",
            { reason: "dataset_not_fixed" },
          );
        }
        const [made] = added;
        return {
          data: { rowId: made?.id ?? null, name: made?.name ?? row.name, datasetId: dataset.id },
          hint: "The row counts in the next run of each eval that uses this dataset.",
        };
      },
    }),
    defineOperation({
      id: "evals_remove_dataset_row",
      domain: "evals",
      title: "Remove a row from a dataset",
      description:
        "Use this tool to remove one row from a fixed dataset. This tool changes data: the next runs do not read the row. The runs that read it keep their copy. It returns the removed row id.",
      keywords: ["evals", "dataset row", "remove row"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        dataset: datasetParam,
        rowId: uuidParam().describe("The id of a row. evals_get_dataset gives the row ids."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const dataset = await findDataset(deps, ctx.projectId, params.dataset);
        if (!dataset) throw notFound("dataset");
        const removed = await removeDatasetRow(ctx.projectId, dataset.id, params.rowId, {
          datasets: deps.datasets(),
          now: deps.now,
        });
        if (!removed.ok) {
          if (removed.reason === "not_found") throw notFound("row of the dataset");
          throw new McpOperationError("conflict", removed.message, { reason: removed.reason });
        }
        return {
          data: { rowId: params.rowId, datasetId: dataset.id },
          hint: "The next run of each eval that uses this dataset reads one row less.",
        };
      },
    }),
    defineOperation({
      id: "evals_preview_dataset",
      domain: "evals",
      title: "Preview a query dataset",
      description:
        "Use this tool to see what a query dataset reads now, before a run freezes it. Give a dataset, or a kind with its settings. Nothing is saved. It returns the number of turns found and the first rows with their input, which is captured text: the key and the project must allow it.",
      keywords: ["evals", "dataset preview", "rql dataset", "last traces"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({
        ...projectScoped,
        dataset: datasetParam.optional().describe("A query dataset (name or id). Or give a kind."),
        kind: z.enum(["last_traces", "task_traces", "rql", "auto"]).optional(),
        limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
        taskId: z.string().trim().min(1).max(200).optional(),
        text: z.string().trim().min(1).max(20_000).optional().describe("The RQL text of kind rql."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        let query: z.output<typeof datasetQuerySchema>;
        if (params.dataset !== undefined) {
          const dataset = await findDataset(deps, ctx.projectId, params.dataset);
          if (!dataset) throw notFound("dataset");
          query = dataset.query;
        } else {
          const parsed = datasetQuerySchema.safeParse({
            kind: params.kind,
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
            ...(params.text === undefined ? {} : { text: params.text }),
          });
          if (!parsed.success) {
            const message = parsed.error.issues[0]?.message ?? "Give a dataset or a kind.";
            throw invalidParams(message, [{ path: "kind", message }]);
          }
          query = parsed.data;
        }
        const preview = await previewQuery(
          ctx.projectId,
          { by: requester(ctx.auth), mayReadContent: await deps.mayReadContent(ctx) },
          query,
          { traces: deps.traces() },
        );
        if (!preview.ok) {
          return {
            data: { ok: false, reason: preview.reason, message: preview.message },
            hint: preview.message,
          };
        }
        return {
          data: preview,
          hint: `A run would read up to ${preview.found} turns now, and freeze the rows that it finds.`,
        };
      },
    }),
    defineOperation({
      id: "evals_list_scorers",
      domain: "evals",
      title: "List the scorer library",
      description:
        "Use this tool to see the scorers that an eval can use. A scorer is a check or a judge. It returns the scorers of the project, the pre-defined scorers with their settings, and the scorers that an eval holds. Each one says if an eval trial can run it, and why not.",
      keywords: ["evals", "scorer library", "pre-defined scorers"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const scorers = await listScorerLibrary(ctx.projectId, {
          library: deps.library(),
          evals: deps.evals(),
        });
        return {
          data: { scorers },
          hint: 'Give a scorer to evals_create with ref {"source":"project","scorerId":...} or {"source":"predefined","key":...,"settings":{...}}.',
        };
      },
    }),
    defineOperation({
      id: "evals_get_history",
      domain: "evals",
      title: "Read the runs of an eval",
      description:
        "Use this tool to see how the score of one eval changed over its runs. It returns each run, the newest first, with its dataset, runtime version, scorers, params, score and delta against the baseline of the eval. It also returns the pass rate of each scorer in each run, the oldest first.",
      keywords: ["evals", "score history", "runs of an eval", "trend"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({
        ...projectScoped,
        eval: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("The name or the id of an eval. evals_list gives them."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const evals = deps.evals();
        const definition =
          (await evals.getByName(ctx.projectId, params.eval)) ??
          (z.uuid().safeParse(params.eval).success
            ? await evals.get(ctx.projectId, params.eval)
            : null);
        if (!definition) throw notFound("eval");
        const [recent, pinned] = await Promise.all([
          deps.runs(ctx.projectId, HISTORY_RUNS),
          deps.baselineOf(ctx.projectId, definition.id),
        ]);
        const runs = await withPinnedRuns(recent, [pinned], (id) => deps.run(ctx.projectId, id));
        const baseline = runs.find(({ experiment }) => experiment.id === pinned) ?? null;
        const history = evalHistory({ definition, runs, baseline });
        return {
          data: history,
          hint:
            history.runs.length === 0
              ? `No run yet. Call evals_start_run with eval "${definition.name}".`
              : "Call evals_get_run with a runId for its cases and outputs.",
        };
      },
    }),
  ];
}

async function requireEvals(deps: EvalDatasetsDeps, projectId: string): Promise<void> {
  if (await deps.enabled(projectId)) return;
  throw new McpOperationError("forbidden", "Evals are not on for this project.", {
    reason: "evals_off",
  });
}

async function findDataset(deps: EvalDatasetsDeps, projectId: string, wanted: string) {
  const datasets = deps.datasets();
  const byName = await datasets.getByName(projectId, wanted);
  if (byName) return byName;
  return z.uuid().safeParse(wanted).success ? datasets.get(projectId, wanted) : null;
}

type RowParams = {
  name?: string | undefined;
  turnId?: string | undefined;
  sandboxRunId?: string | undefined;
  values?: Record<string, unknown> | undefined;
  expectedOutput?: string | undefined;
  labels?: string[] | undefined;
};

/** The row of a turn, of a sandbox run or of typed values. A turn copies captured text. */
async function rowOf(
  deps: EvalDatasetsDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  params: RowParams,
): Promise<NewRow> {
  const given = [params.turnId, params.sandboxRunId, params.values].filter(
    (one) => one !== undefined,
  );
  if (given.length !== 1) {
    throw invalidParams("Give one of turnId, sandboxRunId or values.", [
      { path: "turnId", message: "Give one of turnId, sandboxRunId or values." },
    ]);
  }
  const labels = params.labels ? { labels: [...new Set(params.labels)] } : {};
  const expectedOutput = params.expectedOutput ?? null;
  if (params.turnId) {
    if (!(await deps.mayReadContent(ctx))) {
      throw new McpOperationError(
        "forbidden",
        "A row from a turn copies captured text. This key or this project does not allow it.",
        { reason: "no_content_access" },
      );
    }
    const turn = await deps.turnRow(ctx.projectId, params.turnId);
    if (!turn) throw notFound("turn with an input");
    return {
      kind: "trace",
      name: params.name ?? `Turn ${params.turnId.slice(0, 8)}`,
      ...labels,
      turnId: params.turnId,
      content: { ...turn.content, expectedOutput: expectedOutput ?? turn.content.expectedOutput },
      sourceOutput: turn.sourceOutput,
    };
  }
  if (params.sandboxRunId) {
    const run = await deps.getSandboxRun(ctx.projectId, params.sandboxRunId);
    if (!run) throw notFound("sandbox run");
    const found = rowOfSandboxRun(run);
    if (!found.ok) throw new McpOperationError("conflict", found.message, { reason: "run_active" });
    return {
      kind: "trace",
      name: params.name ?? `Playground run ${params.sandboxRunId.slice(0, 8)}`,
      ...labels,
      turnId: null,
      content: {
        input: storable(found.input),
        earlierTurns: [],
        toolFixtures: [],
        expectedOutput,
      },
      sourceOutput: found.output,
    };
  }
  if (!params.name) {
    throw invalidParams("Give the row a name.", [{ path: "name", message: "Give a name." }]);
  }
  const row = valueRowSchema.safeParse({ values: params.values, expectedOutput });
  if (!row.success) {
    const message = row.error.issues[0]?.message ?? "The values are not valid.";
    throw invalidParams(message, [{ path: "values", message }]);
  }
  return { kind: "values", name: params.name, ...labels, row: row.data };
}

function requester(auth: McpAuthContext): string {
  return auth.kind === "api-key" ? `mcp:key:${auth.apiKeyId}` : `mcp:user:${auth.userId}`;
}

function shortJson(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > INPUT_CHARS ? `${text.slice(0, INPUT_CHARS)}…` : text;
}
