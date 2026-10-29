import { z } from "zod";
import { importSkills } from "@/lib/catalog/import";
import { createSkillInput } from "@/lib/catalog/manage";
import { countSkills, createSkill, getActiveSkillByName, updateSkill } from "@/lib/catalog/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { v1MutationErrorResponse, v1QuotaExceededResponse } from "@/lib/platform/v1-errors";

export const runtime = "nodejs";

const importInput = z.object({
  skills: z.array(createSkillInput).min(1).max(100),
});

/**
 * POST /api/v1/skills/import — Bearer-authed bulk upsert-by-name (S2), for
 * onboarding an existing SKILL.md folder via `skills.import()` in the SDK.
 * All-or-nothing quota gate; response `{ created, updated, unchanged }` (names).
 * See `lib/catalog/import.ts` for the semantics.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(req: Request) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });

  const body = await req.json().catch(() => null);
  const input = importInput.safeParse(body);
  if (!input.success) {
    return Response.json({ error: "invalid", issues: input.error.issues }, { status: 400 });
  }
  const names = input.data.skills.map((s) => s.name);
  if (new Set(names).size !== names.length) {
    return Response.json({ error: "invalid", reason: "duplicate_name" }, { status: 400 });
  }

  const org = await getOrganizationByProjectId(resolved.projectId);
  if (!org) return v1MutationErrorResponse("not_found");

  const outcome = await importSkills(resolved.projectId, org, input.data.skills, {
    getActiveSkillByName,
    createSkill,
    updateSkill,
    countSkills,
  });
  if (!outcome.ok) {
    if (outcome.reason === "quota_exceeded") {
      return v1QuotaExceededResponse("maxSkillsPerProject", outcome.message);
    }
    return v1MutationErrorResponse("version_conflict");
  }
  const { created, updated, unchanged } = outcome;
  return Response.json({ created, updated, unchanged });
}
