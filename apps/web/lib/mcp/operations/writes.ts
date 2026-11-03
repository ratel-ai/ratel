import { z } from "zod";
import { importSkills } from "@/lib/catalog/import";
import { createSkillInput, editSkillInput, statusTransitionInput } from "@/lib/catalog/manage";
import {
  countSkills,
  createSkill,
  getActiveSkillByName,
  type SkillMutationResult,
  setSkillStatus,
  updateSkill,
} from "@/lib/catalog/queries";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { throwMutationFailure } from "@/lib/mcp/operations/mutation-errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { detailSkill } from "@/lib/mcp/serialize";
import { checkQuota } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";

/**
 * Writes, at strict parity with the Bearer-authed `/api/v1` surface.
 *
 * Every mutation here is one an `rtl_` key can already perform over HTTP, so
 * exposing it through MCP adds reach, not privilege. The same quota checks and
 * the same optimistic-concurrency guards apply, and the underlying `lib/**`
 * functions are reused rather than reimplemented so the two surfaces cannot
 * drift.
 *
 * Deliberately absent, permanently: billing, organization deletion, and member
 * management. Those are not capability gaps to fill later. An agent acting on
 * attacker-influenced content (an ingested skill body, a tool description) with
 * a credential that can cancel a subscription is a blast radius no convenience
 * justifies.
 */
export interface WriteOperationDeps {
  createSkill: typeof createSkill;
  updateSkill: typeof updateSkill;
  setSkillStatus: typeof setSkillStatus;
  countSkills: typeof countSkills;
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  getActiveSkillByName: typeof getActiveSkillByName;
  importSkills: typeof importSkills;
}

export const defaultWriteDeps: WriteOperationDeps = {
  createSkill,
  updateSkill,
  setSkillStatus,
  countSkills,
  getOrganizationByProjectId,
  getActiveSkillByName,
  importSkills,
};

function unwrap(result: SkillMutationResult) {
  if (!result.ok) throwMutationFailure(result.reason, "skill");
  return result.skill;
}

export function writeOperations(deps: WriteOperationDeps = defaultWriteDeps): McpOperation[] {
  return [
    defineOperation({
      id: "create_skill",
      domain: "writes",
      title: "Create skill",
      description:
        "Add a skill to the project catalog. Subject to the organization's skills-per-project plan limit. Creates as a draft unless status is set to published.",
      keywords: ["create", "add", "new skill", "author"],
      scope: "project",
      mutates: true,
      params: z.object({ ...projectScoped, skill: createSkillInput }),
      async execute(ctx, params) {
        const organization = await deps.getOrganizationByProjectId(ctx.projectId);
        if (!organization) throw notFound("organization");

        // Identical gate to POST /api/v1/skills: the limit belongs to the
        // organization, not to the transport that reached it.
        const quota = checkQuota(
          organization,
          "maxSkillsPerProject",
          await deps.countSkills(ctx.projectId),
        );
        if (!quota.ok) {
          throw new McpOperationError("quota_exceeded", quota.message, {
            reason: "maxSkillsPerProject",
          });
        }

        const input = params.skill;
        const result = await deps.createSkill({
          projectId: ctx.projectId,
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
        if (!result.ok) throwMutationFailure(result.reason, "skill");
        return { data: { skill: detailSkill(result.skill) } };
      },
    }),
    defineOperation({
      id: "update_skill",
      domain: "writes",
      title: "Update skill",
      description:
        "Change one or more fields of an existing skill. Pass expectedVersion to make the edit conditional on the version you read, which is how concurrent edits are detected.",
      keywords: ["update", "edit skill description", "change", "modify", "rewrite"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        skillId: z.string().uuid(),
        patch: editSkillInput,
      }),
      async execute(ctx, params) {
        const { expectedVersion, ...patch } = params.patch;
        const result = await deps.updateSkill(
          ctx.projectId,
          params.skillId,
          expectedVersion,
          patch,
        );
        return { data: { skill: detailSkill(unwrap(result)) } };
      },
    }),
    defineOperation({
      id: "publish_skill",
      domain: "writes",
      title: "Publish skill",
      description:
        "Move a skill to published so the retrieval engine can serve it. Publishing bumps the project's catalog version.",
      keywords: ["publish", "release", "activate", "live"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        skillId: z.string().uuid(),
        ...statusTransitionInput.shape,
      }),
      async execute(ctx, params) {
        const result = await deps.setSkillStatus(ctx.projectId, params.skillId, "published", {
          expectedVersion: params.expectedVersion,
        });
        return { data: { skill: detailSkill(unwrap(result)) } };
      },
    }),
    defineOperation({
      id: "archive_skill",
      domain: "writes",
      title: "Archive skill",
      description:
        "Move a skill to archived so it stops being served. Archiving is reversible by publishing again; it does not delete the skill.",
      keywords: ["archive", "retire", "unpublish", "remove"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        skillId: z.string().uuid(),
        ...statusTransitionInput.shape,
      }),
      async execute(ctx, params) {
        const result = await deps.setSkillStatus(ctx.projectId, params.skillId, "archived", {
          expectedVersion: params.expectedVersion,
        });
        return { data: { skill: detailSkill(unwrap(result)) } };
      },
    }),
    defineOperation({
      id: "import_skills",
      domain: "writes",
      title: "Import skills",
      description:
        "Bulk upsert skills by name: each one is created if absent, updated if its content differs, and left alone if identical. Made for onboarding an existing folder of skill files in one call. The plan limit is checked against the whole batch first, so an import that would exceed it changes nothing at all.",
      keywords: ["import", "bulk", "upsert", "onboard", "migrate", "batch"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        skills: z.array(createSkillInput).min(1).max(100),
      }),
      async execute(ctx, params) {
        // Names are the upsert key, so a repeated one in a single batch is
        // ambiguous rather than merely redundant: the later entry would silently
        // overwrite the earlier one's create.
        const names = params.skills.map((skill) => skill.name);
        if (new Set(names).size !== names.length) {
          throw invalidParams("Each skill name may appear only once in an import.");
        }

        const organization = await deps.getOrganizationByProjectId(ctx.projectId);
        if (!organization) throw notFound("organization");

        const outcome = await deps.importSkills(ctx.projectId, organization, params.skills, {
          getActiveSkillByName: deps.getActiveSkillByName,
          createSkill: deps.createSkill,
          updateSkill: deps.updateSkill,
          countSkills: deps.countSkills,
        });
        if (!outcome.ok) {
          if (outcome.reason === "quota_exceeded") {
            throw new McpOperationError("quota_exceeded", outcome.message, {
              reason: "maxSkillsPerProject",
            });
          }
          throwMutationFailure("version_conflict", "skill");
        }

        const { created, updated, unchanged } = outcome;
        return {
          data: {
            created,
            updated,
            unchanged,
            counts: {
              created: created.length,
              updated: updated.length,
              unchanged: unchanged.length,
            },
          },
          hint: created.length
            ? "Imported skills start as drafts unless status was set to published. Use publish_skill to serve them."
            : undefined,
        };
      },
    }),
  ];
}
