import { serializeSkill } from "@/lib/catalog/http";
import { createSkillInput, SKILL_STATUSES, type SkillStatus } from "@/lib/catalog/manage";
import { countSkills, createSkill, listSkills } from "@/lib/catalog/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { checkQuota } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { v1MutationErrorResponse, v1QuotaExceededResponse } from "@/lib/platform/v1-errors";

export const runtime = "nodejs";

/**
 * The Bearer-authed skills collection route — the project-key counterpart to the
 * session-authed `/api/skills-catalog` (S2). Response shapes match the
 * SDK skills client contract (`list` / `create`); error bodies are the
 * machine-code v1 shape (`lib/v1-errors.ts`).
 *
 *  - GET  /api/v1/skills?status=&endUserId= → `{ count, skills }`
 *  - POST /api/v1/skills → 201 `{ skill }` (quota-gated like the dashboard POST)
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  if (statusParam && !SKILL_STATUSES.includes(statusParam as SkillStatus)) {
    return Response.json({ error: "invalid", reason: "invalid_status" }, { status: 400 });
  }
  const endUserId = url.searchParams.get("endUserId");

  const items = await listSkills(resolved.projectId, {
    status: (statusParam as SkillStatus | null) ?? undefined,
    endUser: endUserId ?? undefined,
  });
  return Response.json({ count: items.length, skills: items.map(serializeSkill) });
}

export const POST = withRequestLog(handlePost);

async function handlePost(req: Request) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });

  const body = await req.json().catch(() => null);
  const input = createSkillInput.safeParse(body);
  if (!input.success) {
    return Response.json({ error: "invalid", issues: input.error.issues }, { status: 400 });
  }

  const org = await getOrganizationByProjectId(resolved.projectId);
  if (!org) return v1MutationErrorResponse("not_found");
  const quota = checkQuota(org, "maxSkillsPerProject", await countSkills(resolved.projectId));
  if (!quota.ok) return v1QuotaExceededResponse("maxSkillsPerProject", quota.message);

  const result = await createSkill({
    projectId: resolved.projectId,
    name: input.data.name,
    description: input.data.description,
    searchableDescription: input.data.searchableDescription ?? null,
    body: input.data.body,
    tags: input.data.tags,
    tools: input.data.tools,
    metadata: input.data.metadata,
    status: input.data.status,
    model: input.data.model ?? null,
    endUserId: input.data.endUserId ?? null,
  });
  if (!result.ok) return v1MutationErrorResponse(result.reason);
  return Response.json({ skill: serializeSkill(result.skill) }, { status: 201 });
}
