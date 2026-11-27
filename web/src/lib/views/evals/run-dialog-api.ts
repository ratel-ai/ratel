import { z } from "zod";
import { forMember, type Member, refuse, reply } from "@/lib/console/scope/member-access";
import { resolveDataset } from "./datasets";
import { RESOLVE_STATUS, rowsOfTurns } from "./datasets-api";
import { datasetQuerySchema } from "./domain/dataset";
import { MAX_EVAL_TRIALS, matrixValueSchema } from "./domain/eval";
import { type EvalRunChanges, startEvalRun } from "./eval-runs";
import type { StartRefusal } from "./experiments";
import { type ConsoleDeps, readJson, urlOf } from "./experiments-api";
import type { NewRow } from "./ports/dataset-store";
import { scorerRequestSchema, withDefinitions } from "./scorer-library";

/**
 * The session route of "New run" on an eval page (decision `runs-per-eval`): a run of the eval with
 * its defaults, or with changes for this run only. Another dataset, more rows (chosen traces, the
 * last N traces, or traces that Ratel chooses), other scorers, a pinned runtime version, other
 * param values or a matrix, other trials. The run records what changed.
 */

const STATUS: Record<StartRefusal, number> = {
  sandboxes_off: 409,
  not_found: 404,
  not_ready: 409,
  no_cases: 409,
  too_many_running: 429,
  too_many_trials: 413,
  invalid_params: 400,
  wrong_sandbox: 409,
  no_content_access: 403,
  query_failed: 422,
  too_many_rows: 413,
  invalid_scorers: 400,
  shared_dataset: 409,
};

const paramValue = z.union([z.string(), z.number(), z.boolean()]);
/** Rows for this run only: chosen traces, or a query that Ratel resolves now. */
/** The rows that one run adds for itself: each one is loaded in the request. */
const MAX_ADDED_ROWS = 100;
const addRowsSchema = z.union([
  z.object({ turnIds: z.array(z.uuid()).min(1).max(MAX_ADDED_ROWS) }),
  z.object({
    query: datasetQuerySchema
      .refine(
        ({ kind }) => kind === "last_traces" || kind === "auto",
        "add the last traces, or traces that Ratel chooses",
      )
      .refine(
        (query) => !("limit" in query) || query.limit <= MAX_ADDED_ROWS,
        `a run adds at most ${MAX_ADDED_ROWS} rows for itself`,
      ),
  }),
]);
const runSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  datasetId: z.uuid().optional(),
  addRows: addRowsSchema.optional(),
  scorers: z.array(scorerRequestSchema).min(1).max(50).optional(),
  sandboxVersion: z.union([z.literal("latest"), z.uuid()]).optional(),
  params: z.record(z.string(), paramValue).optional(),
  matrix: matrixValueSchema.optional(),
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS).optional(),
});

export function handleStartEvalRunByMember(
  request: Request,
  projectId: string,
  evalId: string,
  deps: ConsoleDeps,
): Promise<Response> {
  const span = { feature: "evals", operation: "start_eval_run" } as const;
  return forMember(
    projectId,
    span,
    deps,
    async (member: Member) => {
      const body = runSchema.safeParse(await readJson(request));
      if (!body.success) return invalid(body.error);
      if (!z.uuid().safeParse(evalId).success)
        return refuse(404, "not_found", "There is no such eval.");
      const { name, datasetId, addRows, scorers: asked, ...rest } = body.data;
      const experimentDeps = deps.experiments();
      const rows = addRows
        ? await rowsToAdd(member.projectId, addRows, experimentDeps.traces)
        : null;
      if (rows && !rows.ok) return rows.response;
      const scorers = asked
        ? await withDefinitions(member.projectId, asked, experimentDeps.library)
        : null;
      if (scorers && !scorers.ok) return refuse(400, "invalid_scorers", scorers.message);
      const changes: EvalRunChanges = {
        ...rest,
        ...(datasetId ? { dataset: datasetId } : {}),
        ...(rows ? { rows: rows.rows } : {}),
        ...(scorers ? { scorers: scorers.scorers } : {}),
      };
      const result = await startEvalRun(
        { projectId: member.projectId, organizationId: member.organizationId },
        { eval: evalId, startedBy: member.externalId, ...(name ? { name } : {}), changes },
        experimentDeps,
      );
      if (!result.ok) return refuse(STATUS[result.reason], result.reason, result.message);
      const { experiment } = result;
      deps.advance(experiment);
      await deps.track(experiment, { externalId: member.externalId, surface: "console" });
      return reply(201, { experimentId: experiment.id, url: urlOf(experiment, deps) });
    },
    { write: true },
  );
}

async function rowsToAdd(
  projectId: string,
  asked: z.output<typeof addRowsSchema>,
  source: ReturnType<ConsoleDeps["experiments"]>["traces"],
): Promise<{ ok: true; rows: NewRow[] } | { ok: false; response: Response }> {
  if ("turnIds" in asked) return rowsOfTurns(projectId, asked.turnIds, source);
  const resolved = await resolveDataset(projectId, asked.query, source);
  if (!resolved.ok) {
    return {
      ok: false,
      response: refuse(RESOLVE_STATUS[resolved.reason], resolved.reason, resolved.message),
    };
  }
  return {
    ok: true,
    rows: resolved.rows.map(({ turnId, content, sourceOutput }) => ({
      kind: "trace",
      name: "Trace turn",
      turnId,
      content,
      sourceOutput,
    })),
  };
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}
