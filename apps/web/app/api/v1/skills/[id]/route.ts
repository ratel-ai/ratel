import { serializeSkill } from "@/lib/catalog/http";
import { editSkillInput } from "@/lib/catalog/manage";
import { getSkillById, updateSkill } from "@/lib/catalog/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { v1MutationErrorResponse } from "@/lib/platform/v1-errors";

export const runtime = "nodejs";

/**
 * Bearer-authed single-skill route (S2), scoped to the key's own project —
 * `getSkillById(projectId, id)` doubles as the ownership check, so a foreign
 * id is indistinguishable from a missing one (404, no existence leak).
 *
 *  - GET   /api/v1/skills/[id] → `{ skill }`
 *  - PATCH /api/v1/skills/[id] (editSkillInput; optional expectedVersion guard) → `{ skill }`
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });
  const { id } = await params;

  const skill = await getSkillById(resolved.projectId, id);
  if (!skill) return v1MutationErrorResponse("not_found");
  return Response.json({ skill: serializeSkill(skill) });
}

export const PATCH = withRequestLog(handlePatch);

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const input = editSkillInput.safeParse(body);
  if (!input.success) {
    return Response.json({ error: "invalid", issues: input.error.issues }, { status: 400 });
  }

  const { expectedVersion, ...patch } = input.data;
  const result = await updateSkill(resolved.projectId, id, expectedVersion, patch);
  if (!result.ok) return v1MutationErrorResponse(result.reason);
  return Response.json({ skill: serializeSkill(result.skill) });
}
