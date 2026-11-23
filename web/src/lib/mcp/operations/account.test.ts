import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { resolveConfig } from "@/config";
import { OSS_LIMITS } from "@/lib/adapters/oss/entitlements";
import { composition } from "@/lib/composition/ports";
import type { EntitlementsPort, OrgLimitView, PlanLimits } from "@/lib/contracts/entitlements";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { type AccountOperationDeps, accountOperations } from "./account";

/**
 * The quota read an agent uses to tell "no data" from "not allowed": quota counted as the
 * console counts it (the demo project is free), limits that say "unlimited" rather than null,
 * the plan and its subscription state, and the match quality run budget.
 *
 * Owned (ADR-0004): upstream's quota cases. Its plan table is the edition's, so the cases that
 * need one install a stand-in for it (`withPlans`); the open-source edition has none.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const quiet = { warn: () => {}, error: () => {}, info: () => {} } as never;

const keyAuth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

type PlanRow = {
  plan: string;
  planOverride: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
};

function organization(patch: Partial<PlanRow> = {}): Organization {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme",
    plan: "free",
    planOverride: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    ...patch,
  } as Organization;
}

function project(id: string, isDemo = false): Project {
  return { id, organizationId: "org-1", isDemo } as Project;
}

function deps(overrides: Partial<AccountOperationDeps> = {}): AccountOperationDeps {
  return {
    getOrganizationByProjectId: async () => organization(),
    countSkills: async () => 2,
    countMemberships: async () => 1,
    listProjectsForOrganization: async () => [project("p-1")],
    getJobForProject: async () => null,
    listInFlightJobs: async () => [],
    countMatchQualityRunsSince: async () => 0,
    now: () => NOW,
    editionToolListed: () => false,
    featureEnabled: async () => false,
    ...overrides,
  };
}

async function run(operationId: string, overrides: Partial<AccountOperationDeps> = {}) {
  const result = await dispatchOperation(
    operationId,
    { projectId: PROJECT },
    {
      registry: buildRegistry(accountOperations(deps(overrides))),
      auth: keyAuth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as { ok: true; data: Record<string, unknown>; hint?: string };
}

/** A stand-in for an edition's plan table, shaped as upstream's: Hobby, Pro and Enterprise. */
const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    ...OSS_LIMITS,
    maxProjects: 1,
    maxMembers: 1,
    maxSkillsPerProject: 10,
    matchQualityRunsPerMonth: 0,
  },
  pro: {
    ...OSS_LIMITS,
    maxProjects: 10,
    maxMembers: 10,
    maxSkillsPerProject: 100,
    matchQualityRunsPerMonth: 4,
  },
  enterprise: OSS_LIMITS,
};
const PLAN_NAMES: Record<string, string> = { free: "Hobby", pro: "Pro", enterprise: "Enterprise" };

function planOf(org: OrgLimitView): string {
  const row = org as unknown as PlanRow;
  return row.planOverride ?? row.plan ?? "free";
}

function withPlans(t: TestContext): void {
  const previous = composition.entitlements;
  const limitsOf = (org: OrgLimitView) => PLAN_LIMITS[planOf(org)] ?? PLAN_LIMITS.free;
  const port: EntitlementsPort = {
    ...previous,
    planId: planOf,
    getLimits: limitsOf,
    checkQuota(org, key, currentCount) {
      const limit = limitsOf(org)[key];
      if (currentCount < limit) return { ok: true };
      return { ok: false, plan: planOf(org), limit, message: `limit of ${limit}. Upgrade` };
    },
    checkMeteredFeature(org, key, used, noun) {
      const limit = limitsOf(org)[key];
      const plan = planOf(org);
      if (limit <= 0) {
        return {
          ok: false,
          reason: "not_on_plan",
          plan,
          message: `${noun} is not included in ${PLAN_NAMES[plan]}.`,
        };
      }
      if (used >= limit) return { ok: false, reason: "exhausted", plan, limit, message: "used up" };
      return { ok: true, limit, used, remaining: limit - used };
    },
    plans: {
      summary(org) {
        const row = org as unknown as PlanRow;
        const id = planOf(org);
        const paid = id !== "free";
        return {
          id,
          name: PLAN_NAMES[id],
          paid,
          subscriptionStatus: row.subscriptionStatus,
          pastDue: paid && row.subscriptionStatus === "past_due",
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
          selfServeBilling: row.planOverride === null,
        };
      },
      withAgentHealthWindow: () => "pro",
      name: (planId) => PLAN_NAMES[planId],
    },
  };
  composition.entitlements = port;
  t.after(() => {
    composition.entitlements = previous;
  });
}

interface QuotaRow {
  quota: string;
  current: number;
  limit: number | null;
  unlimited: boolean;
  withinLimit: boolean;
  note?: string;
  message?: string;
}

test("the demo project does not count toward the project limit, as in the console", async (t) => {
  withPlans(t);
  const { data } = await run("get_quota_status", {
    listProjectsForOrganization: async () => [project("p-1"), project("demo", true)],
  });
  const projects = (data.quotas as QuotaRow[]).find((row) => row.quota === "maxProjects");

  assert.equal(projects?.current, 1);
  assert.equal(projects?.limit, 1);
  assert.equal(
    projects?.withinLimit,
    false,
    "Free allows one project, and the one real project uses it",
  );
  assert.match(projects?.note ?? "", /demo project/);
});

test("Enterprise limits say unlimited rather than serializing as null", async (t) => {
  withPlans(t);
  const { data } = await run("get_quota_status", {
    getOrganizationByProjectId: async () =>
      organization({ plan: "free", planOverride: "enterprise" }),
    countMatchQualityRunsSince: async () => 7,
  });
  const quotas = data.quotas as QuotaRow[];
  const limits = data.limits as Record<string, unknown>;

  assert.ok(quotas.every((row) => row.unlimited && row.limit === null && row.withinLimit));
  assert.equal(limits.maxProjects, "unlimited");
  // JSON round trip, as the transport does it: nothing turns into null.
  assert.equal(JSON.parse(JSON.stringify(limits)).maxMembers, "unlimited");
  const runs = data.matchQualityRuns as Record<string, unknown>;
  assert.equal(runs.unlimited, true);
  assert.equal(runs.summary, "Unlimited runs");
});

test("plan and subscription state come from the same helpers as the Billing page", async (t) => {
  withPlans(t);
  const { data } = await run("get_quota_status", {
    getOrganizationByProjectId: async () =>
      organization({
        plan: "pro",
        subscriptionStatus: "past_due",
        currentPeriodEnd: new Date("2026-11-30T00:00:00.000Z"),
      }),
    countMatchQualityRunsSince: async () => 1,
  });
  const plan = data.plan as Record<string, unknown>;
  assert.equal(plan.id, "pro");
  assert.equal(plan.name, "Pro");
  assert.equal(plan.paid, true);
  assert.equal(plan.pastDue, true);
  assert.equal(plan.currentPeriodEnd, "2026-11-30T00:00:00.000Z");
  assert.equal(plan.selfServeBilling, true);

  const runs = data.matchQualityRuns as Record<string, unknown>;
  assert.equal(runs.remaining, 3);
  assert.equal(runs.summary, "3 runs left this month");
  assert.equal(runs.resetsAt, "2026-12-01T00:00:00.000Z");
});

test("match quality not on the plan says so", async (t) => {
  withPlans(t);
  const { data } = await run("get_quota_status");
  const runs = data.matchQualityRuns as Record<string, unknown>;
  assert.equal(runs.included, false);
  assert.equal(runs.resetsAt, null);
  assert.match(String(runs.summary), /not included/);
});

test("without an edition's plans: no plan block, and every limit is unlimited", async () => {
  const { data } = await run("get_quota_status", {
    countMatchQualityRunsSince: async () => 2,
  });
  assert.equal("plan" in data, false);
  const limits = data.limits as Record<string, unknown>;
  assert.equal(limits.maxProjects, "unlimited");
  assert.equal(limits.agentHealthWindowDays, 90);
  assert.ok((data.quotas as QuotaRow[]).every((row) => row.unlimited && row.withinLimit));
  const runs = data.matchQualityRuns as Record<string, unknown>;
  assert.deepEqual(
    { included: runs.included, used: runs.used, unlimited: runs.unlimited, summary: runs.summary },
    { included: true, used: 2, unlimited: true, summary: "Unlimited runs" },
  );
});

test("get_job_status refuses a job id that is not a UUID as the other id params do", async () => {
  const result = await dispatchOperation(
    "get_job_status",
    { projectId: PROJECT, jobId: "not-a-job" },
    {
      registry: buildRegistry(accountOperations(deps())),
      auth: keyAuth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /Must be a UUID\./);
});

test("get_flag_status reports each switch as the flags port decides it for this project and caller", async () => {
  const asked: unknown[] = [];
  const result = await run("get_flag_status", {
    featureEnabled: async (flag, subject) => {
      asked.push([flag, subject]);
      return flag === "evalGate";
    },
  });
  const flags = result.data.flags as { key: string; enabled: boolean }[];
  assert.deepEqual(
    flags.map(({ key, enabled }) => [key, enabled]),
    [
      ["evalGate", true],
      ["rankingCatalogDrift", false],
      ["mcpApps", false],
      ["agentsPages", false],
      ["toolRunInsights", false],
      ["sentimentAnalysis", false],
      ["hallucinationDetection", false],
    ],
  );
  const subject = { organizationId: "org-1", projectId: PROJECT, actor: `project:${PROJECT}` };
  assert.deepEqual(asked, [
    ["evalGate", subject],
    ["rankingCatalogDrift", subject],
    ["mcpApps", subject],
    ["agentsPages", subject],
    ["toolRunInsights", subject],
    ["sentimentAnalysis", subject],
    ["hallucinationDetection", subject],
  ]);
});

// RP-63, decision mcp-apps-scope: under an OAuth connection the MCP Apps flag is connection-wide,
// decided for the person alone. get_flag_status must report what the real gate decides.
test("get_flag_status reports MCP Apps as the real gate decides it for an OAuth connection", async (t) => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const { mcpAppsEnabled } = await import("@/lib/mcp/apps/flag");
  // The edition's flags service turns Apps on for organization org-1 only.
  const port = {
    enabled: async (flag: string, subject: { organizationId?: string }) =>
      flag === "mcpApps" && subject.organizationId === "org-1",
  };
  const ports = composition as { featureFlags?: unknown };
  const previous = ports.featureFlags;
  ports.featureFlags = port;
  t.after(() => {
    ports.featureFlags = previous;
  });
  const oauth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_ada",
    userId: "u-1",
    memberships: [
      {
        organizationId: "org-1",
        role: "admin",
        organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
      },
    ],
  };
  const result = await dispatchOperation(
    "get_flag_status",
    { projectId: PROJECT },
    {
      registry: buildRegistry(accountOperations(deps({ featureEnabled }))),
      auth: oauth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const flags = (result as { data: { flags: { key: string; enabled: boolean }[] } }).data.flags;
  const reported = flags.find(({ key }) => key === "mcpApps")?.enabled;
  assert.equal(reported, await mcpAppsEnabled(oauth, resolveConfig()));
  assert.equal(reported, false);
});

test("get_flag_status reports MCP Apps for a project key with that project, as the gate does", async (t) => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const { mcpAppsEnabled } = await import("@/lib/mcp/apps/flag");
  const port = {
    enabled: async (flag: string, subject: { projectId?: string }) =>
      flag === "mcpApps" && subject.projectId === PROJECT,
  };
  const ports = composition as { featureFlags?: unknown };
  const previous = ports.featureFlags;
  ports.featureFlags = port;
  t.after(() => {
    ports.featureFlags = previous;
  });
  const result = await run("get_flag_status", { featureEnabled });
  const flags = result.data.flags as { key: string; enabled: boolean }[];
  const reported = flags.find(({ key }) => key === "mcpApps")?.enabled;
  assert.equal(reported, await mcpAppsEnabled(keyAuth, resolveConfig()));
  assert.equal(reported, true);
});
