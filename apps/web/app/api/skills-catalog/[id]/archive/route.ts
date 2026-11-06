import { mutationErrorResponse, resolveSkill, serializeSkill } from "@/lib/catalog/http";
import { statusTransitionInput } from "@/lib/catalog/manage";
import { setSkillStatus } from "@/lib/catalog/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

/**
 * POST /api/skills-catalog/[id]/archive { expectedVersion? } — archive a skill
 * (account-authed). Removes it from the published set (freeing its name for reuse)
 * and recomputes the catalog ETag when it had been published.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveSkill(id);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, {
    project_id: resolved.skill.projectId,
    org_id: resolved.accountId,
    distinct_id: resolved.externalId,
  });

  const parsed = statusTransitionInput.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await setSkillStatus(resolved.skill.projectId, id, "archived", {
    expectedVersion: parsed.data.expectedVersion,
  });
  if (!result.ok) return mutationErrorResponse(result.reason);

  return Response.json(serializeSkill(result.skill));
}
