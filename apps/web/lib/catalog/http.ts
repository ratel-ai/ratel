import { getSkillWithOrganizationId } from "@/lib/catalog/queries";
import type { ResolvedProject } from "@/lib/catalog/resolve-project";
import type { Skill } from "@/lib/catalog/schema";
import { getMembership } from "@/lib/platform/identity/queries";
import { getProjectBySlug } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

/**
 * The Bearer and session helpers the catalog APIs share. Owned slim surface of the upstream
 * module: membership is the boundary, as upstream; there are no support sessions.
 */

export { type ResolvedProject, resolveProjectById } from "@/lib/catalog/resolve-project";
export { type SerializedSkill, serializeSkill } from "@/lib/catalog/serialize";

/** Authenticate the session and resolve a project by slug within the session organization. */
export async function resolveProject(slug: string | null): Promise<ResolvedProject> {
  const ctx = await getSessionContext();
  if (!ctx) {
    return { ok: false, response: Response.json({ error: "Not authenticated." }, { status: 401 }) };
  }
  if (!slug) {
    return { ok: false, response: Response.json({ error: "Missing project." }, { status: 400 }) };
  }
  const project = await getProjectBySlug(ctx.organization.id, slug);
  if (!project) {
    return { ok: false, response: Response.json({ error: "Project not found." }, { status: 404 }) };
  }
  return {
    ok: true,
    accountId: ctx.organization.id,
    externalId: ctx.user.externalId,
    organization: ctx.organization,
    project,
  };
}

export type ResolvedSkill =
  | { ok: true; accountId: string; externalId: string; skill: Skill }
  | { ok: false; response: Response };

export interface ResolveSkillDeps {
  getSessionContext: typeof getSessionContext;
  getSkillWithOrganizationId: typeof getSkillWithOrganizationId;
  getMembership(userId: string, organizationId: string): Promise<{ role: string } | null>;
}

const DEFAULT_RESOLVE_SKILL_DEPS: ResolveSkillDeps = {
  getSessionContext,
  getSkillWithOrganizationId,
  getMembership,
};

/**
 * Authenticate the session and resolve a skill by id, authorized by membership of the
 * organization that owns the skill's project. A skill outside the caller's organizations gets
 * the same 404 as a missing one, so the routes never confirm that an id exists elsewhere.
 */
export async function resolveSkill(
  id: string,
  deps: ResolveSkillDeps = DEFAULT_RESOLVE_SKILL_DEPS,
): Promise<ResolvedSkill> {
  const ctx = await deps.getSessionContext();
  if (!ctx) {
    return { ok: false, response: Response.json({ error: "Not authenticated." }, { status: 401 }) };
  }
  const found = await deps.getSkillWithOrganizationId(id);
  const membership = found ? await deps.getMembership(ctx.user.id, found.organizationId) : null;
  if (!found || !membership) {
    return { ok: false, response: Response.json({ error: "Skill not found." }, { status: 404 }) };
  }
  return {
    ok: true,
    accountId: found.organizationId,
    externalId: ctx.user.externalId,
    skill: found.skill,
  };
}

/** Map a mutation failure reason to its HTTP response (404 or 409). */
export function mutationErrorResponse(
  reason: "not_found" | "version_conflict" | "name_conflict",
): Response {
  if (reason === "not_found") {
    return Response.json({ error: "Skill not found." }, { status: 404 });
  }
  if (reason === "name_conflict") {
    return Response.json(
      { error: "A skill with that name already exists in this project.", reason },
      { status: 409 },
    );
  }
  return Response.json(
    { error: "Version conflict. The skill changed since you read it. Re-read and retry.", reason },
    { status: 409 },
  );
}
