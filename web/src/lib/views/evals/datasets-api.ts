import { z } from "zod";
import {
  forMember,
  type Member,
  type MemberAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";
import { storable } from "@/lib/platform/storable";
import { inputText } from "./dataset-pages";
import { type ResolveRefusal, resolveDataset } from "./datasets";
import { caseContentSchema } from "./domain/case";
import { type Dataset, datasetDetailsSchema, datasetQuerySchema } from "./domain/dataset";
import { caseFromTurn } from "./domain/from-turn";
import type { DatasetStore, NewRow } from "./ports/dataset-store";
import type { TraceSource } from "./ports/trace-source";

/**
 * The session routes of the Datasets pages (decision `datasets-first-class`): create a dataset of
 * one kind, add rows to a fixed one (from turns or typed values), remove a row, and preview what a
 * query resolves now. A run resolves a query again when it starts and freezes its rows.
 */
export type DatasetsApiDeps = MemberAccessDeps & {
  datasets: () => DatasetStore;
  /** The traces, as a query dataset reads them. It also loads the turns of chosen rows. */
  source: () => TraceSource;
};

/** The rows that a person adds at one time. */
const MAX_TURNS = 100;
/** The rows that a preview builds. */
export const PREVIEW_ROWS = 10;
const MAX_BODY_CHARS = 200_000;
const MAX_TEXT_CHARS = 20_000;

const STATUS: Record<ResolveRefusal, number> = {
  not_a_query: 400,
  no_content_access: 403,
  query_failed: 422,
  too_many_rows: 413,
  no_rows: 422,
};

const turnIdsSchema = z.array(z.uuid()).min(1).max(MAX_TURNS);
const createSchema = datasetDetailsSchema
  .extend({
    query: datasetQuerySchema.default({ kind: "fixed" }),
    turnIds: turnIdsSchema.optional(),
  })
  .refine(({ query, turnIds }) => !turnIds || query.kind === "fixed", {
    path: ["turnIds"],
    message: "a query dataset holds no row: a run resolves it",
  });
/** A typed row: one input text, and what the agent should answer. */
const typedRowSchema = z.object({
  name: z.string().trim().min(1, "give the row a name").max(200),
  input: z.string().trim().min(1, "write the input").max(MAX_TEXT_CHARS),
  expectedOutput: z
    .string()
    .trim()
    .max(MAX_TEXT_CHARS)
    .nullable()
    .default(null)
    .transform((text) => text || null),
});
const addSchema = z.union([
  z.object({ turnIds: turnIdsSchema }),
  z.object({ row: typedRowSchema }),
]);
const previewSchema = z.object({ query: datasetQuerySchema });

export function handleCreateDataset(
  request: Request,
  projectId: string,
  deps: DatasetsApiDeps,
): Promise<Response> {
  return write(projectId, "create_dataset", deps, async (member) => {
    const body = createSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { turnIds, query, ...details } = body.data;
    const rows = turnIds ? await rowsOfTurns(member.projectId, turnIds, deps) : null;
    if (rows && !rows.ok) return rows.response;
    const datasets = deps.datasets();
    const made = await datasets.create({
      projectId: member.projectId,
      ...details,
      query,
      createdBy: member.externalId,
    });
    if (made === "name_taken") {
      return refuse(409, "name_taken", "Another dataset of the project has this name.");
    }
    if (rows) await datasets.addRows(member.projectId, made.id, rows.rows, member.externalId);
    return reply(201, { dataset: datasetView(made), rows: rows?.rows.length ?? 0 });
  });
}

/** Adds rows to a fixed dataset: the turns that a person chose, or one typed row. */
export function handleAddDatasetRows(
  request: Request,
  projectId: string,
  datasetId: string,
  deps: DatasetsApiDeps,
): Promise<Response> {
  return write(projectId, "add_dataset_rows", deps, async (member) => {
    const body = addSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    if (!isId(datasetId)) return datasetNotFound();
    let rows: NewRow[];
    if ("row" in body.data) {
      const { name, input, expectedOutput } = body.data.row;
      rows = [{ kind: "values", name, row: { values: { input }, expectedOutput } }];
    } else {
      const fromTurns = await rowsOfTurns(member.projectId, body.data.turnIds, deps);
      if (!fromTurns.ok) return fromTurns.response;
      rows = fromTurns.rows;
    }
    const added = await deps
      .datasets()
      .addRows(member.projectId, datasetId, rows, member.externalId);
    if (added === "not_found") return datasetNotFound();
    if (added === "not_fixed") return notFixed();
    return reply(201, { rows: added.map(({ id, name }) => ({ rowId: id, name })) });
  });
}

export function handleRemoveDatasetRow(
  projectId: string,
  datasetId: string,
  rowId: string,
  deps: DatasetsApiDeps,
): Promise<Response> {
  return write(projectId, "remove_dataset_row", deps, async (member) => {
    if (!isId(datasetId) || !isId(rowId)) return rowNotFound();
    const removed = await deps.datasets().removeRow(member.projectId, datasetId, rowId);
    if (removed === "not_found") return rowNotFound();
    if (removed === "not_fixed") return notFixed();
    return reply(200, { removed: rowId });
  });
}

/**
 * What a query resolves now: its first rows, with no row kept. A run resolves it again when it
 * starts, so the rows of a run can differ.
 */
export function handlePreviewDataset(
  request: Request,
  projectId: string,
  deps: DatasetsApiDeps,
): Promise<Response> {
  const span = { feature: "evals", operation: "preview_dataset" } as const;
  return forMember(projectId, span, deps, async (member) => {
    const body = previewSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { query } = body.data;
    const resolved = await resolveDataset(member.projectId, query, deps.source(), {
      take: PREVIEW_ROWS,
    });
    if (!resolved.ok) return refuse(STATUS[resolved.reason], resolved.reason, resolved.message);
    return reply(200, {
      limit: "limit" in query ? query.limit : null,
      found: resolved.found,
      rows: resolved.rows.map(({ turnId, content, sourceOutput }) => ({
        turnId,
        input: inputText(content.input),
        output: sourceOutput,
      })),
    });
  });
}

/** A row for each turn, in order, each turn one time. Refused when one turn cannot give a row. */
async function rowsOfTurns(
  projectId: string,
  turnIds: readonly string[],
  deps: DatasetsApiDeps,
): Promise<{ ok: true; rows: NewRow[] } | { ok: false; response: Response }> {
  const source = deps.source();
  if (!(await source.readContent(projectId))) {
    return {
      ok: false,
      response: refuse(
        403,
        "no_content_access",
        "This project does not let Ratel read captured text, so no row can be built from its traces. An admin can change it in Settings.",
      ),
    };
  }
  const readOnly = await source.readOnlyTools(projectId);
  const rows: NewRow[] = [];
  for (const turnId of new Set(turnIds)) {
    const turn = await source.loadTurn(projectId, turnId);
    if (!turn)
      return { ok: false, response: refuse(404, "not_found", `There is no turn ${turnId}.`) };
    const made = caseFromTurn(turn, readOnly);
    if (!made) {
      return {
        ok: false,
        response: refuse(422, "no_input", `The turn ${turnId} has no captured input.`),
      };
    }
    const content = caseContentSchema.safeParse(made.content);
    if (!content.success) return { ok: false, response: invalid(content.error) };
    rows.push({
      kind: "trace",
      name: made.name,
      turnId,
      content: content.data,
      sourceOutput: made.sourceOutput,
    });
  }
  return { ok: true, rows };
}

function write(
  projectId: string,
  operation: string,
  deps: DatasetsApiDeps,
  work: (member: Member) => Promise<Response>,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation }, deps, work, { write: true });
}

function datasetView(dataset: Dataset) {
  return {
    datasetId: dataset.id,
    name: dataset.name,
    description: dataset.description,
    query: dataset.query,
    updatedAt: dataset.updatedAt.toISOString(),
  };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value === null ? null : storable(value);
  } catch {
    return null;
  }
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}

function isId(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

function datasetNotFound(): Response {
  return refuse(404, "dataset_not_found", "There is no such dataset.");
}

function rowNotFound(): Response {
  return refuse(404, "not_found", "There is no such row in the dataset.");
}

function notFixed(): Response {
  return refuse(409, "dataset_not_fixed", "A query dataset holds no row. A run resolves it.");
}
