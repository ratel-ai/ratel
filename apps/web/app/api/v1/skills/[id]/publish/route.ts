import { serializeSkill } from "@/lib/catalog/http";
import { statusTransitionInput } from "@/lib/catalog/manage";
import { setSkillStatus } from "@/lib/catalog/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { v1MutationErrorResponse } from "@/lib/platform/v1-errors";

export const runtime = "nodejs";

/**
 * POST /api/v1/skills/[id]/publish — Bearer-authed publish (S2), the project-key
 * counterpart to `/api/skills-catalog/[id]/publish`. Optional `expectedVersion`
 * CAS; `name_conflict` is reachable when publishing collides with a live
 * same-name row. Response `{ skill }`.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const input = statusTransitionInput.safeParse(body ?? {});
  if (!input.success) {
    return Response.json({ error: "invalid", issues: input.error.issues }, { status: 400 });
  }

  const result = await setSkillStatus(resolved.projectId, id, "published", {
    expectedVersion: input.data.expectedVersion,
  });
  if (!result.ok) return v1MutationErrorResponse(result.reason);
  return Response.json({ skill: serializeSkill(result.skill) });
}
