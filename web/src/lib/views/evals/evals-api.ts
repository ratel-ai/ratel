import { z } from "zod";
import {
  forMember,
  type Member,
  type MemberAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";
import {
  currentVersion,
  type EvalContent,
  type EvalVersion,
  evalContentSchema,
  evalDetailsSchema,
  libraryRefs,
} from "./domain/eval";
import { readJson } from "./experiments-api";
import type { EvalStore } from "./ports/eval-store";

/**
 * The session routes of eval definitions: create, and edit. An edit with other content adds a
 * version, so a run that started keeps the version that it froze.
 */
export type EvalsApiDeps = MemberAccessDeps & { evals: () => EvalStore; now: () => Date };

const definitionSchema = evalDetailsSchema.extend({
  content: evalContentSchema.default(evalContentSchema.parse({})),
});
const editSchema = definitionSchema.extend({ base: z.uuid() });

export function handleCreateEval(
  request: Request,
  projectId: string,
  deps: EvalsApiDeps,
): Promise<Response> {
  return write(projectId, "create_eval", deps, async (member) => {
    const body = definitionSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const made = await deps
      .evals()
      .create({ ...body.data, projectId: member.projectId, createdBy: member.externalId });
    if (made === "name_taken") return nameTaken();
    if (made === "dataset_not_found") return datasetNotFound();
    const version = currentVersion(made);
    return reply(201, { evalId: made.id, versionId: version.id, number: version.number });
  });
}

export function handleEditEval(
  request: Request,
  projectId: string,
  evalId: string,
  deps: EvalsApiDeps,
): Promise<Response> {
  return write(projectId, "edit_eval", deps, async (member) => {
    const json = await readJson(request);
    const body = editSchema.safeParse(json);
    if (!body.success) return invalid(body.error);
    if (!z.uuid().safeParse(evalId).success) return notFound();
    const { base, ...edit } = body.data;
    const current = await deps.evals().get(member.projectId, evalId);
    if (!current) return notFound();
    edit.content = keptContent(edit.content, json, currentVersion(current));
    const saved = await deps.evals().update(member.projectId, evalId, edit, base, {
      userId: member.externalId,
      now: deps.now(),
    });
    if (saved === "not_found") return notFound();
    if (saved === "changed") {
      return refuse(409, "changed", "Another person changed this eval. Read it again.");
    }
    if (saved === "name_taken") return nameTaken();
    if (saved === "dataset_not_found") return datasetNotFound();
    const version = currentVersion(saved);
    return reply(200, { evalId, versionId: version.id, number: version.number });
  });
}

/**
 * The console editor knows the eval's own scorers, its sandbox, params and trials. What it does not
 * send stays as the newest version has it: the matrix, the pinned version, and the references to
 * the library.
 */
function keptContent(content: EvalContent, json: unknown, newest: EvalVersion): EvalContent {
  const given =
    typeof json === "object" && json !== null && "content" in json
      ? ((json as { content?: unknown }).content ?? {})
      : {};
  const has = (key: string) => typeof given === "object" && given !== null && key in given;
  const onlyOwn = content.scorers.every(
    (ref) => ref.source !== "project" && ref.source !== "predefined",
  );
  return {
    ...content,
    matrix: has("matrix") ? content.matrix : newest.matrix,
    sandboxVersionId: has("sandboxVersionId") ? content.sandboxVersionId : newest.sandboxVersionId,
    scorers: !has("scorers")
      ? newest.scorers
      : onlyOwn
        ? [...content.scorers, ...libraryRefs(newest.scorers)]
        : content.scorers,
  };
}

function datasetNotFound(): Response {
  return refuse(404, "dataset_not_found", "The project has no such dataset.");
}

function write(
  projectId: string,
  operation: string,
  deps: EvalsApiDeps,
  work: (member: Member) => Promise<Response>,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation }, deps, work, { write: true });
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}

function nameTaken(): Response {
  return refuse(409, "name_taken", "Another eval of the project has this name.");
}

function notFound(): Response {
  return refuse(404, "not_found", "Not found.");
}
