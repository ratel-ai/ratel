import { mutationErrorResponse, resolveProject, serializeSkill } from "@/lib/catalog/http";
import { createSkillInput, SKILL_STATUSES, type SkillStatus } from "@/lib/catalog/manage";
import { countSkills, createSkill, listSkills } from "@/lib/catalog/queries";
import { checkQuota } from "@/lib/platform/entitlements";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackProductEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

/**
 * The account-authed skills-catalog collection route (Phase 2 human CRUD — distinct
 * from the Bearer-authed /api/v1/catalog sync the SDK pulls).
 *
 *  - GET  /api/skills-catalog?project=<slug>[&status=draft|published|archived]
 *    → the project's skills (optionally filtered by status), newest-updated first.
 *  - POST /api/skills-catalog  { project, name, description, body, tags?, tools?,
 *    metadata?, status? } → create a skill (draft by default), 201.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const resolved = await resolveProject(url.searchParams.get("project"));
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, {
    project_id: resolved.project.id,
    org_id: resolved.accountId,
    distinct_id: resolved.externalId,
  });

  const statusParam = url.searchParams.get("status");
  if (statusParam && !SKILL_STATUSES.includes(statusParam as SkillStatus)) {
    return Response.json({ error: `Invalid status "${statusParam}".` }, { status: 400 });
  }

  const items = await listSkills(resolved.project.id, {
    status: (statusParam as SkillStatus | null) ?? undefined,
  });
  return Response.json({ items: items.map(serializeSkill) });
}

export const POST = withRequestLog(handlePost);

async function handlePost(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | ({ project?: string } & Record<string, unknown>)
    | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  const resolved = await resolveProject(typeof body.project === "string" ? body.project : null);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, {
    project_id: resolved.project.id,
    org_id: resolved.accountId,
    distinct_id: resolved.externalId,
  });

  const parsed = createSkillInput.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid skill.", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  // Enforce the plan's per-project catalog-item cap before creating.
  const skillCount = await countSkills(resolved.project.id);
  const quota = checkQuota(resolved.organization, "maxSkillsPerProject", skillCount);
  if (!quota.ok) {
    await trackProductEvent(
      "quota_limit_hit",
      {
        externalId: resolved.externalId,
        orgId: resolved.accountId,
        projectId: resolved.project.id,
      },
      { limit: "maxSkillsPerProject", cap: quota.limit },
    );
    return Response.json({ error: quota.message }, { status: 403 });
  }

  const result = await createSkill({
    projectId: resolved.project.id,
    name: input.name,
    description: input.description,
    searchableDescription: input.searchableDescription ?? null,
    body: input.body,
    tags: input.tags,
    tools: input.tools,
    metadata: input.metadata,
    status: input.status,
    model: input.model ?? null,
    endUserId: input.endUserId ?? null,
  });
  if (!result.ok) return mutationErrorResponse(result.reason);

  return Response.json(serializeSkill(result.skill), { status: 201 });
}
