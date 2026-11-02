import { z } from "zod";
import { countSkills } from "@/lib/catalog/queries";
import { getJobForProject, listInFlightJobs } from "@/lib/jobs/queries";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { APP_NAME } from "@/lib/platform/app-config";
import { checkQuota, getLimits, type QuotaKey } from "@/lib/platform/entitlements";
import { countMemberships, getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";

/**
 * Account status: the "why is my call failing" domain.
 *
 * Most writes are quota-gated, so an agent that cannot read quota state has no
 * way to distinguish "your project has no data" from "you hit a plan limit".
 * Without these operations every dead end looks the same and the agent's next
 * move is a guess. Nothing is behind a flag any more; `get_flag_status` stays
 * so agents that call it get that answer.
 *
 * Upstream also answers `get_embedding_usage` here; the Embedding API and its
 * credit ledger are not part of this edition, so the tool is not registered.
 */
export interface AccountOperationDeps {
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  countSkills: typeof countSkills;
  countMemberships: typeof countMemberships;
  listProjectsForOrganization: typeof listProjectsForOrganization;
  getJobForProject: typeof getJobForProject;
  listInFlightJobs: typeof listInFlightJobs;
}

export const defaultAccountDeps: AccountOperationDeps = {
  getOrganizationByProjectId,
  countSkills,
  countMemberships,
  listProjectsForOrganization,
  getJobForProject,
  listInFlightJobs,
};

const QUOTA_KEYS: readonly QuotaKey[] = ["maxProjects", "maxSkillsPerProject", "maxMembers"];

export function accountOperations(deps: AccountOperationDeps = defaultAccountDeps): McpOperation[] {
  return [
    defineOperation({
      id: "get_flag_status",
      domain: "account",
      title: "Feature flag status",
      description: `Kept for agents that call it: every ${APP_NAME} surface is on for every organization, so this always returns an empty list. An empty result from any other tool means there is no data, not a switched-off surface.`,
      keywords: ["flags", "enabled", "disabled", "feature access"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute() {
        return {
          data: { count: 0, flags: [] },
          hint: "Nothing is behind a flag: every surface is on for every organization.",
        };
      },
    }),
    defineOperation({
      id: "get_quota_status",
      domain: "account",
      title: "Plan limits",
      description:
        "The organization's plan, its numeric limits (projects, skills per project, members), and current usage against each. Explains quota_exceeded errors on writes.",
      keywords: ["plan limit", "quota", "plan", "tier", "near the limit"],
      scope: "organization",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const organization = await deps.getOrganizationByProjectId(ctx.projectId);
        if (!organization) throw notFound("organization");

        const [skills, members, projects] = await Promise.all([
          deps.countSkills(ctx.projectId),
          deps.countMemberships(organization.id),
          deps.listProjectsForOrganization(organization.id),
        ]);
        const limits = getLimits(organization);
        const counts: Record<QuotaKey, number> = {
          maxProjects: projects.length,
          maxSkillsPerProject: skills,
          maxMembers: members,
        };

        return {
          data: {
            organization: { id: organization.id, slug: organization.slug },
            limits,
            quotas: QUOTA_KEYS.map((key) => {
              const result = checkQuota(organization, key, counts[key]);
              return {
                quota: key,
                current: counts[key],
                limit: limits[key],
                withinLimit: result.ok,
                ...(result.ok ? {} : { message: result.message }),
              };
            }),
          },
        };
      },
    }),
    defineOperation({
      id: "get_job_status",
      domain: "account",
      title: "Background job status",
      description:
        "Status of a background job by id, or every job currently queued or running for the project. Analysis work such as a match quality run is queued, so poll this rather than assuming it failed.",
      keywords: ["job", "queue", "async", "poll", "in flight"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        jobId: z
          .string()
          .uuid()
          .optional()
          .describe("A specific job id, as returned by an operation that enqueues work."),
      }),
      async execute(ctx, params) {
        if (params.jobId) {
          const job = await deps.getJobForProject(ctx.projectId, params.jobId);
          if (!job) throw notFound("job");
          return {
            data: {
              job: {
                id: job.id,
                kind: job.kind,
                status: job.status,
                error: job.error,
                createdAt: job.createdAt?.toISOString() ?? null,
                startedAt: job.startedAt?.toISOString() ?? null,
                finishedAt: job.finishedAt?.toISOString() ?? null,
              },
            },
          };
        }

        const inFlight = await deps.listInFlightJobs(ctx.projectId);
        return {
          data: { inFlightCount: inFlight.length, inFlight },
          hint: inFlight.length
            ? "Re-run this operation with a jobId to follow one job to completion."
            : "Nothing queued right now.",
        };
      },
    }),
  ];
}
