import { z } from "zod";
import {
  forMember,
  type Member,
  type MemberAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";
import { currentVersion, evalContentSchema, evalDetailsSchema } from "./domain/eval";
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
    const body = editSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    if (!z.uuid().safeParse(evalId).success) return notFound();
    const { base, ...edit } = body.data;
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

function datasetNotFound(): Response {
  return refuse(404, "dataset_not_found", "There is no such dataset.");
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
