import { mutationErrorResponse, resolveSkill, serializeSkill } from "@/lib/catalog/http";
import { editSkillInput } from "@/lib/catalog/manage";
import { updateSkill } from "@/lib/catalog/queries";
import { toSkillMarkdown } from "@/lib/catalog/skills/markdown";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

/**
 * A single catalog skill (account-authed CRUD).
 *
 *  - GET   /api/skills-catalog/[id] → the skill + its assembled SKILL.md markdown.
 *  - PATCH /api/skills-catalog/[id] { expectedVersion, ...fields } → edit under
 *    optimistic concurrency (409 on a version or name conflict, 404 if gone).
 */
export const GET = withRequestLog(handleGet);

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveSkill(id);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(_req, {
    project_id: resolved.skill.projectId,
    org_id: resolved.accountId,
    distinct_id: resolved.externalId,
  });

  const skill = resolved.skill;
  return Response.json({
    ...serializeSkill(skill),
    markdown: toSkillMarkdown({
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      body: skill.body,
    }),
  });
}

export const PATCH = withRequestLog(handlePatch);

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveSkill(id);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, {
    project_id: resolved.skill.projectId,
    org_id: resolved.accountId,
    distinct_id: resolved.externalId,
  });

  const body = await req.json().catch(() => null);
  const parsed = editSkillInput.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid edit.", issues: parsed.error.issues }, { status: 400 });
  }
  // The wire field names match the column names directly (`tools` included).
  const { expectedVersion, ...patch } = parsed.data;

  const result = await updateSkill(resolved.skill.projectId, id, expectedVersion, patch);
  if (!result.ok) return mutationErrorResponse(result.reason);

  return Response.json(serializeSkill(result.skill));
}
