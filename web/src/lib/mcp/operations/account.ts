import { z } from "zod";
import { countSkills } from "@/lib/catalog/queries";
import { composition } from "@/lib/composition/ports";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import type { CoreFlag } from "@/lib/contracts/feature-flags";
import { getJobForProject, listInFlightJobs } from "@/lib/jobs/queries";
import { MCP_APPS_FLAG, mcpAppsFlagSubject } from "@/lib/mcp/apps/flag";
import { notFound } from "@/lib/mcp/errors";
import { editionToolListed } from "@/lib/mcp/operations/edition";
import { mcpActor } from "@/lib/mcp/operations/health";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import {
  checkMeteredFeature,
  checkQuota,
  getLimits,
  type OrgLimitView,
  type PlanLimits,
  planSummary,
  type QuotaKey,
} from "@/lib/platform/entitlements";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { projectCapacity } from "@/lib/platform/projects/capacity";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { countRunsSince } from "@/lib/synthesis/match-quality/queries";
import { nextBillingPeriodStart, startOfBillingPeriod } from "@/lib/synthesis/match-quality/window";
import { budgetLine, type RunBudget } from "@/lib/views/quality/run-menu";

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
 * credit ledger belong to the edition, which adds that tool through
 * `Registration.mcpOperations` (`edition.ts`). `get_quota_status` points at it
 * only when it is listed.
 */
/**
 * The core's switches, as `get_flag_status` reports them, each read as its callers read it
 * (`featureEnabled`): without the edition's flags port, one configured switch for the
 * deployment (`flags.<key>`; in the open-source edition also `experimentalFeatures`); with it,
 * the edition's value for this organization and caller, after any value the operator forced.
 */
const DEPLOYMENT_SWITCHES: readonly { key: CoreFlag; note: string }[] = [
  { key: "evalGate", note: "simulations, eval sets and task scores before a fix ships" },
  {
    key: "rankingCatalogDrift",
    note: "adaptive ranking warns only about tools a published catalog dropped, and prunes them on rebuild",
  },
  {
    key: "mcpApps",
    note: "this MCP server publishes interactive ui:// views (MCP Apps) and points its tools at them",
  },
  {
    key: "agentsPages",
    note: "the Agents and MCP servers pages, their tools (list_agents, get_agent, list_mcp_servers, get_mcp_server) and agent overrides",
  },
  {
    key: "toolRunInsights",
    note: "tool-run insights: Tasks from small projects, derived asks for tool-only runs, agent runs from invoke_agent spans, Agent health from 10 turns",
  },
  {
    key: "sentimentAnalysis",
    note: "The console's Sentiment analysis page under Traces, and task completion with its root causes on Agent health. No tool reads them yet.",
  },
  {
    key: "hallucinationDetection",
    note: "The console's Hallucinations page under Agent health, and its markers in Traces. No tool reads it yet.",
  },
  {
    key: "focusedConsole",
    note: "the simplified console: Overview as a recap, Agent health as the score and its categories, Self-corrections under Insights",
  },
];

export interface AccountOperationDeps {
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  countSkills: typeof countSkills;
  countMemberships: (organizationId: string) => Promise<number>;
  listProjectsForOrganization: typeof listProjectsForOrganization;
  getJobForProject: typeof getJobForProject;
  listInFlightJobs: typeof listInFlightJobs;
  /** Match quality runs the project started since a date (the console's run budget count). */
  countMatchQualityRunsSince: (projectId: string, since: Date) => Promise<number>;
  now: () => Date;
  /** Whether the edition lists a tool, so a hint names only tools the caller has. */
  editionToolListed: (id: string) => boolean;
  /** A core switch for whoever asks: the edition's flags port when it has one, else the configuration. */
  featureEnabled: typeof featureEnabled;
  /** `focusedConsole`, as the rail and the pages decide it. */
  focusedConsoleEnabled: (organization: { id: string }) => Promise<boolean>;
}

export const defaultAccountDeps: AccountOperationDeps = {
  getOrganizationByProjectId,
  countSkills,
  countMemberships: (organizationId) => composition.session.countMembers(organizationId),
  listProjectsForOrganization,
  getJobForProject,
  listInFlightJobs,
  countMatchQualityRunsSince: (projectId, since) => countRunsSince(projectId, since),
  now: () => new Date(),
  editionToolListed: (id) => editionToolListed(id),
  featureEnabled: (flag, subject) => featureEnabled(flag, subject),
  focusedConsoleEnabled: (organization) => focusedConsoleEnabled(organization),
};

const QUOTA_KEYS: readonly QuotaKey[] = ["maxProjects", "maxSkillsPerProject", "maxMembers"];

/* ---------------------------------- quota --------------------------------- */

/** JSON has no Infinity: an unlimited limit would serialize as null and read as "no limit known". */
function limitValue(value: number): number | "unlimited" {
  return Number.isFinite(value) ? value : "unlimited";
}

function serializeLimits(limits: PlanLimits): Record<keyof PlanLimits, number | "unlimited"> {
  return Object.fromEntries(
    Object.entries(limits).map(([key, value]) => [key, limitValue(value)]),
  ) as Record<keyof PlanLimits, number | "unlimited">;
}

/** The match quality run budget as the Quality page's menu words it (`lib/views/quality`). */
function matchQualityBudget(organization: OrgLimitView, used: number, now: Date) {
  const access = checkMeteredFeature(
    organization,
    "matchQualityRunsPerMonth",
    used,
    "Match quality",
  );
  const resetsAt = nextBillingPeriodStart(now);
  if (access.ok) {
    const unlimited = !Number.isFinite(access.limit);
    const budget: RunBudget = { spent: false, remaining: access.remaining };
    return {
      included: true,
      used,
      limit: unlimited ? null : access.limit,
      remaining: unlimited ? null : access.remaining,
      unlimited,
      resetsAt: resetsAt.toISOString(),
      summary: budgetLine(budget),
    };
  }
  if (access.reason === "not_on_plan") {
    return {
      included: false,
      used,
      limit: 0,
      remaining: 0,
      unlimited: false,
      resetsAt: null,
      summary: access.message,
    };
  }
  const budget: RunBudget = { spent: true, limit: access.limit, resetsAt };
  return {
    included: true,
    used,
    limit: access.limit,
    remaining: 0,
    unlimited: false,
    resetsAt: resetsAt.toISOString(),
    summary: budgetLine(budget),
  };
}

export function accountOperations(deps: AccountOperationDeps = defaultAccountDeps): McpOperation[] {
  return [
    defineOperation({
      id: "get_flag_status",
      domain: "account",
      title: "Feature flag status",
      description:
        "The deployment's feature switches and whether each is on: the eval gate, adaptive ranking's catalog drift and MCP Apps views. A switched-off surface refuses with forbidden and names its switch; an empty result from any other tool means there is no data.",
      keywords: ["flags", "enabled", "disabled", "feature access"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const subject = {
          ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
          projectId: ctx.projectId,
          actor: mcpActor(ctx.auth, ctx.projectId),
        };
        // Each switch with its gate's subject: MCP Apps for the connection, the others for the project.
        const subjectOf = (key: CoreFlag) =>
          key === MCP_APPS_FLAG ? mcpAppsFlagSubject(ctx.auth) : subject;
        // The rail and the pages decide focusedConsole for the organization alone.
        const focusedConsole = async () => {
          const id =
            ctx.organizationId ?? (await deps.getOrganizationByProjectId(ctx.projectId))?.id;
          return id !== undefined && deps.focusedConsoleEnabled({ id });
        };
        const flags = await Promise.all(
          DEPLOYMENT_SWITCHES.map(async ({ key, note }) => ({
            key,
            enabled:
              key === "focusedConsole"
                ? await focusedConsole()
                : await deps.featureEnabled(key, subjectOf(key)),
            note,
          })),
        );
        return {
          data: { count: flags.length, flags },
          hint: composition.featureFlags
            ? "Each switch is decided for this organization and caller; a value the operator forced in the configuration comes first."
            : "A switch is set for the whole deployment by its operator, not per organization.",
        };
      },
    }),
    defineOperation({
      id: "get_quota_status",
      domain: "account",
      title: "Plan and limits",
      description:
        "The organization's plan and subscription state (paid, past due, period end), its limits, usage against each quota (projects, skills per project, members) counted as the console counts them, and this project's match quality runs left this month. Explains quota_exceeded errors on writes.",
      keywords: [
        "plan limit",
        "quota",
        "plan",
        "tier",
        "near the limit",
        "subscription",
        "past due",
        "billing",
      ],
      scope: "organization",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const organization = await deps.getOrganizationByProjectId(ctx.projectId);
        if (!organization) throw notFound("organization");

        const now = deps.now();
        const [skills, members, projects, matchQualityRuns] = await Promise.all([
          deps.countSkills(ctx.projectId),
          deps.countMemberships(organization.id),
          deps.listProjectsForOrganization(organization.id),
          deps.countMatchQualityRunsSince(ctx.projectId, startOfBillingPeriod(now)),
        ]);
        const limits = getLimits(organization);
        // The demo project does not count against maxProjects, exactly as on the Projects page.
        const capacity = projectCapacity(organization, projects);
        // Owned: only an edition with plans has a plan block; the open-source edition has none.
        const plan = planSummary(organization);
        const counts: Record<QuotaKey, number> = {
          maxProjects: capacity.used,
          maxSkillsPerProject: skills,
          maxMembers: members,
        };

        return {
          data: {
            organization: { id: organization.id, slug: organization.slug },
            ...(plan ? { plan } : {}),
            limits: serializeLimits(limits),
            quotas: QUOTA_KEYS.map((key) => {
              const result = checkQuota(organization, key, counts[key]);
              const unlimited = !Number.isFinite(limits[key]);
              return {
                quota: key,
                current: counts[key],
                limit: unlimited ? null : limits[key],
                unlimited,
                withinLimit: result.ok,
                ...(key === "maxProjects" && capacity.hasDemoProject
                  ? { note: "The demo project does not count toward this limit." }
                  : {}),
                ...(result.ok ? {} : { message: result.message }),
              };
            }),
            matchQualityRuns: matchQualityBudget(organization, matchQualityRuns, now),
          },
          // Upstream's hint, given only where the edition lists the wallet tool it names.
          ...(deps.editionToolListed("get_embedding_usage")
            ? { hint: "get_embedding_usage shows the Embeddings and Tool Picker wallets." }
            : {}),
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
        jobId: uuidParam()
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
