import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import type { QualityEvidence } from "@/lib/views/quality/load-misses";
import type { MissRow } from "@/lib/views/quality/miss-rows";
import { type QualityOperationDeps, qualityOperations } from "./quality";

/**
 * Quality over MCP. These pin the gate the page applies (on the plan, even
 * with this period's runs spent), that end users' search text is capped, that
 * each review action reaches the same apply function the console's buttons do
 * and emits the console's event with surface "mcp", and that a spent allowance
 * reads as quota_exceeded rather than a generic failure.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const PROPOSAL = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-05T12:00:00.000Z");

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

/**
 * Owned: upstream reads Free and Pro from its plan tables. This edition has no plans, so the
 * same limits arrive as `limitOverrides`, which the entitlements port still applies.
 */
const PLAN_LIMITS: Record<string, Record<string, number>> = {
  free: {
    matchQualityRunsPerMonth: 0,
    agentHealthSignalsShown: 3,
    agentHealthEvidenceTurns: 0,
    agentHealthWindowDays: 7,
  },
  plus: {
    matchQualityRunsPerMonth: 0,
    agentHealthEvidenceTurns: 3,
    agentHealthWindowDays: 30,
  },
  pro: { matchQualityRunsPerMonth: 4 },
};

function org(plan: string): Organization {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme",
    plan: "free",
    planOverride: plan,
    subscriptionStatus: null,
    limitOverrides: PLAN_LIMITS[plan] ?? null,
  } as unknown as Organization;
}

function headline(share: number | null) {
  return {
    tier: "judged" as const,
    n: 40,
    hits: 30,
    share,
    change: { direction: "up" as const, text: "+5 pts" },
    trend: [0.71234, null],
    trendUnit: "day" as const,
  };
}

const evidence: QualityEvidence = {
  searches: 120,
  answered: 40,
  headline: headline(0.75),
  found: headline(0.9),
  theirs: null,
  tools: { "tool-refund": { searches: 4, first: 1, found: 2 } },
  groups: [],
  missCount: 3,
  cut: false,
  readLimit: 5_000,
  source: { kind: "experiment", name: "shadow-1", variant: "ratel" },
  experimentName: "shadow-1",
};

function missRow(id: string, query: string, rank: number | null, expected = "Refunds"): MissRow {
  const list = {
    arm: "ratel",
    served: true,
    items: [{ id: "tool-other", name: "Other" }],
    more: 0,
  };
  return {
    id,
    selectionIds: [id],
    query,
    expected: { id: "tool-refund", name: expected },
    rankedFirst: { id: "tool-other", name: "Other" },
    rank,
    evidence: "judged",
    count: 2,
    lastSeen: "2026-11-04T10:00:00.000Z",
    ours: list,
    comparison: null,
    comparisonRank: null,
    traceHref: `/project/${PROJECT}/traces/abc123`,
    test: null,
    rewrite: "pending",
  };
}

function proposal(overrides: Partial<MatchQualityProposalRow> = {}): MatchQualityProposalRow {
  return {
    id: PROPOSAL,
    runId: "run-1",
    projectId: PROJECT,
    entryId: "tool-refund",
    entryName: "Refunds",
    status: "pending",
    currentSearchable: "refund a payment",
    currentSource: "runtime",
    proposedSearchable: "refund a payment, money back, return an order",
    rationale: "Adds the words people use.",
    evidence: {
      misses: 9,
      failures: Array.from({ length: 8 }, (_, index) => ({
        selectionId: `sel-${index}`,
        query: `${"I want my money back please ".repeat(20)}${index}`,
        ourRank: null,
        ourTop: "tool-other",
        baselineTop: null,
        targetSource: "judged",
      })),
    },
    preview: {},
    backtest: null,
    appliedAt: null,
    appliedBy: null,
    revertedAt: null,
    previousOverride: null,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    ...overrides,
  } as MatchQualityProposalRow;
}

const run = {
  id: "run-1",
  experimentName: "shadow-1",
  status: "analyzed",
  declinedReason: null,
  tunedArm: "ratel",
} as unknown as MatchQualityRunRow;

interface Recorded {
  events: Array<{ name: string; context: unknown; properties: Record<string, unknown> }>;
  calls: string[];
}

function deps(
  recorded: Recorded,
  overrides: Partial<QualityOperationDeps> = {},
): QualityOperationDeps {
  const call = (name: string) => recorded.calls.push(name);
  return {
    getOrganizationByProjectId: async () => org("pro"),
    getProjectById: async () => ({ id: PROJECT, name: "Support bot" }),
    countRunsSince: async () => 1,
    getLatestRun: async () => run,
    listProposals: async () => [proposal()],
    loadQualityEvidence: async () => evidence,
    loadMissRows: async () => [
      missRow("sel-a", "where is my refund", null),
      missRow("sel-b", "cancel my order", 3, "Orders"),
      missRow("sel-c", "x".repeat(1_000), null),
    ],
    loadProjection: async () => ({
      pending: 1,
      delta: "+6 pts",
      direction: "up",
      significant: true,
      replayed: 300,
    }),
    loadToolCard: async () => ({
      id: "tool-refund",
      name: "Refunds",
      description: "refund a payment",
      source: "Runtime default",
      tally: null,
      catalogHref: "/x",
    }),
    getOverrideAdoption: async () => true,
    applyDeps: () => ({}) as never,
    applyProposal: async () => {
      call("applyProposal");
      return { ok: true, status: "applied" };
    },
    applyProposals: async (_projectId, ids) => {
      call("applyProposals");
      return { applied: [...ids], failed: [] };
    },
    dismissProposal: async () => {
      call("dismissProposal");
      return { ok: true, status: "dismissed" };
    },
    revertProposal: async () => {
      call("revertProposal");
      return { ok: true, status: "reverted" };
    },
    startManualRun: async () => ({
      ok: true,
      status: "started",
      run: { id: "run-2" } as MatchQualityRunRow,
      jobId: "33333333-3333-4333-8333-333333333333",
      windowDays: 14,
      access: { ok: true, limit: 4, used: 1, remaining: 3 },
    }),
    trackServerEvent: (async (
      name: string,
      context: unknown,
      properties: Record<string, unknown>,
    ) => {
      recorded.events.push({ name, context, properties });
    }) as unknown as QualityOperationDeps["trackServerEvent"],
    now: () => NOW,
    contentOptIn: async () => true,
    ...overrides,
  };
}

function dispatch(
  operationId: string,
  params: Record<string, unknown>,
  overrides: Partial<QualityOperationDeps> = {},
  caller: McpAuthContext = auth,
) {
  const recorded: Recorded = { events: [], calls: [] };
  const result = dispatchOperation(
    operationId,
    { projectId: PROJECT, ...params },
    {
      registry: buildRegistry(qualityOperations(deps(recorded, overrides))),
      auth: caller,
    },
  );
  return { result, recorded };
}

function ok(result: Awaited<ReturnType<typeof dispatchOperation>>): DispatchSuccess {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as DispatchSuccess;
}

test("get_quality: headline, misses, the filter and capped search text", async () => {
  const { result } = await dispatch("get_quality", { range: "30d", outcome: "missing" });
  const data = ok(await result).data as {
    rankedFirst: { share: number; tierLabel: string; trend: (number | null)[] };
    found: { share: number };
    matching: number;
    misses: Array<{
      query: string;
      traceId: string;
      selectionId: string;
      outcome: string;
      rankLabel: string;
    }>;
    window: { range: string };
  };
  assert.equal(data.window.range, "30d");
  assert.equal(data.rankedFirst.share, 0.75);
  assert.equal(data.rankedFirst.tierLabel, "Judged");
  assert.deepEqual(data.rankedFirst.trend, [0.7123, null]);
  assert.equal(data.found.share, 0.9);
  // "cancel my order" was ranked 3rd, so the missing filter drops it.
  assert.equal(data.matching, 2);
  assert.deepEqual(
    data.misses.map((row) => row.outcome),
    ["missing", "missing"],
  );
  assert.equal(data.misses[0]!.traceId, "abc123");
  assert.equal(data.misses[0]!.selectionId, "sel-a");
  assert.equal(data.misses[0]!.rankLabel, "Not returned");
  assert.ok(data.misses[1]!.query.length <= 301, "raw search text is truncated");
  assert.equal(((await result) as DispatchSuccess).truncated, true);
});

test("get_quality: q matches the search and both tool names", async () => {
  const { result } = await dispatch("get_quality", { q: "orders" });
  const data = ok(await result).data as { misses: Array<{ query: string }> };
  assert.deepEqual(
    data.misses.map((row) => row.query),
    ["cancel my order"],
  );
});

test("get_quality: a plan without match quality is refused, a spent one still reads", async () => {
  const refused = await dispatch(
    "get_quality",
    {},
    { getOrganizationByProjectId: async () => org("plus") },
  ).result;
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error, "forbidden");

  const spent = await dispatch("get_quality", {}, { countRunsSince: async () => 4 }).result;
  assert.equal(spent.ok, true);
});

test("list_description_rewrites: rows, the replay of all pending, adoption, and missed searches only counted", async () => {
  let optInReads = 0;
  const { result } = await dispatch(
    "list_description_rewrites",
    {},
    {
      contentOptIn: async () => {
        optInReads += 1;
        return true;
      },
    },
  );
  const response = ok(await result);
  const data = response.data as {
    pending: Array<{
      proposalId: string;
      missedSearches: number;
      missed?: unknown;
      moreMissed?: number;
    }>;
    applied: unknown[];
    projection: { delta: string };
    overridesAdopted: boolean;
  };
  assert.equal(data.pending.length, 1);
  assert.equal(data.pending[0]!.proposalId, PROPOSAL);
  assert.equal(data.pending[0]!.missedSearches, 9);
  assert.ok(
    !("missed" in data.pending[0]!),
    "end users' searches are not listed for every rewrite",
  );
  assert.ok(!("moreMissed" in data.pending[0]!));
  assert.ok(!JSON.stringify(data).includes("I want my money back"));
  assert.equal(optInReads, 0, "nothing captured is listed, so the opt-in is not read");
  assert.equal(data.projection.delta, "+6 pts");
  assert.equal(data.overridesAdopted, true);
  assert.match(response.hint ?? "", /pass proposalId/);
});

test("list_description_rewrites: proposalId lists that rewrite's missed searches, capped", async () => {
  const { result } = await dispatch("list_description_rewrites", { proposalId: PROPOSAL });
  const response = ok(await result);
  const data = response.data as {
    pending: Array<{ proposalId: string; missed: Array<{ query: string }>; moreMissed: number }>;
  };
  assert.equal(data.pending.length, 1);
  assert.equal(data.pending[0]!.missed.length, 5);
  assert.equal(data.pending[0]!.moreMissed, 4);
  assert.ok(data.pending[0]!.missed[0]!.query.length <= 301);
  assert.equal(response.truncated, true);
  assert.doesNotMatch(response.hint ?? "", /pass proposalId/);

  const unknown = await dispatch("list_description_rewrites", {
    proposalId: "99999999-9999-4999-8999-999999999999",
  }).result;
  assert.equal(!unknown.ok && unknown.error, "not_found");
});

test("list_description_rewrites: tool lists its rewrites' missed searches too", async () => {
  const { result } = await dispatch("list_description_rewrites", { tool: "tool-refund" });
  const data = ok(await result).data as { pending: Array<{ missed: unknown[] }> };
  assert.equal(data.pending[0]!.missed.length, 5);
});

test("list_description_rewrites: tool narrows to that tool and adds its card", async () => {
  const { result } = await dispatch("list_description_rewrites", { tool: "tool-other" });
  const data = ok(await result).data as {
    pending: unknown[];
    tool: { id: string };
    toolRewrite: string | null;
  };
  assert.equal(data.pending.length, 0);
  assert.equal(data.tool.id, "tool-refund");
  assert.equal(data.toolRewrite, null);
});

for (const [action, fn, event, status] of [
  ["apply", "applyProposal", "match_quality_proposal_applied", "applied"],
  ["dismiss", "dismissProposal", "match_quality_proposal_dismissed", "dismissed"],
  ["revert", "revertProposal", "match_quality_proposal_reverted", "reverted"],
] as const) {
  test(`review_description_rewrite: ${action} calls ${fn} and emits ${event} from mcp`, async () => {
    const { result, recorded } = await dispatch("review_description_rewrite", {
      action,
      proposalId: PROPOSAL,
    });
    const data = ok(await result).data as { status: string };
    assert.equal(data.status, status);
    assert.deepEqual(recorded.calls, [fn]);
    assert.equal(recorded.events.length, 1);
    assert.equal(recorded.events[0]!.name, event);
    assert.equal(recorded.events[0]!.properties.surface, "mcp");
    assert.equal(recorded.events[0]!.properties.proposal_id, PROPOSAL);
    assert.deepEqual(recorded.events[0]!.context, { projectId: PROJECT, orgId: "org-1" });
  });
}

test("review_description_rewrite: apply_all applies every pending rewrite as one bulk event", async () => {
  const { result, recorded } = await dispatch("review_description_rewrite", {
    action: "apply_all",
  });
  const data = ok(await result).data as { applied: string[] };
  assert.deepEqual(data.applied, [PROPOSAL]);
  assert.deepEqual(recorded.calls, ["applyProposals"]);
  assert.equal(recorded.events[0]!.properties.bulk, true);
  assert.equal(recorded.events[0]!.properties.surface, "mcp");
});

test("review_description_rewrite: a missing proposalId, an acted-on one, and an unknown one", async () => {
  const missing = await dispatch("review_description_rewrite", { action: "apply" }).result;
  assert.equal(!missing.ok && missing.error, "invalid_params");

  const { result: acted, recorded } = await dispatch(
    "review_description_rewrite",
    { action: "revert", proposalId: PROPOSAL },
    { revertProposal: async () => ({ ok: false, reason: "not_pending" }) },
  );
  const conflict = await acted;
  assert.equal(!conflict.ok && conflict.error, "conflict");
  assert.equal(!conflict.ok && conflict.reason, "not_pending");
  assert.equal(recorded.events.length, 0, "a refused action emits nothing");

  const gone = await dispatch(
    "review_description_rewrite",
    { action: "dismiss", proposalId: PROPOSAL },
    { dismissProposal: async () => ({ ok: false, reason: "not_found" }) },
  ).result;
  assert.equal(!gone.ok && gone.error, "not_found");
});

test("run_quality_analysis: starts a run, returns the job to poll and the runs left", async () => {
  let input: Parameters<QualityOperationDeps["startManualRun"]>[0] | null = null;
  const { result, recorded } = await dispatch(
    "run_quality_analysis",
    { windowDays: 14 },
    {
      startManualRun: async (received) => {
        input = received;
        return {
          ok: true,
          status: "started",
          run: { id: "run-2" } as MatchQualityRunRow,
          jobId: "33333333-3333-4333-8333-333333333333",
          windowDays: 14,
          access: { ok: true, limit: 4, used: 1, remaining: 3 },
        };
      },
    },
  );
  const data = ok(await result).data as {
    runId: string;
    jobId: string;
    runsLeftThisMonth: number;
    allowance: string;
  };
  assert.equal(data.runId, "run-2");
  assert.equal(data.jobId, "33333333-3333-4333-8333-333333333333");
  assert.equal(data.runsLeftThisMonth, 2);
  assert.equal(data.allowance, "2 runs left this month");
  assert.deepEqual(input!.project, { id: PROJECT, name: "Support bot" });
  assert.equal(input!.windowDaysRaw, 14);
  assert.equal(recorded.events[0]!.name, "match_quality_run_started");
  assert.equal(recorded.events[0]!.properties.surface, "mcp");
  assert.equal(recorded.events[0]!.properties.window_days, 14);
});

test("run_quality_analysis: a spent allowance is quota_exceeded and emits nothing", async () => {
  const { result, recorded } = await dispatch(
    "run_quality_analysis",
    {},
    {
      startManualRun: async () => ({
        ok: false,
        reason: "quota",
        message: "You have used all 4 of this period's match quality runs.",
        access: { ok: false, reason: "exhausted", plan: "pro", limit: 4, message: "spent" },
      }),
    },
  );
  const response = await result;
  assert.equal(!response.ok && response.error, "quota_exceeded");
  assert.equal(!response.ok && response.reason, "matchQualityRunsPerMonth");
  assert.equal(recorded.events.length, 0);
});

test("run_quality_analysis: only the windows a run offers", async () => {
  const response = await dispatch("run_quality_analysis", { windowDays: 90 }).result;
  assert.equal(!response.ok && response.error, "invalid_params");
});

test("run_quality_analysis: a run already in flight is not an error", async () => {
  const { result, recorded } = await dispatch(
    "run_quality_analysis",
    {},
    {
      startManualRun: async () => ({
        ok: true,
        status: "already_running",
        message: "A run is already in progress.",
        windowDays: 7,
      }),
    },
  );
  const data = ok(await result).data as { started: boolean };
  assert.equal(data.started, false);
  assert.equal(recorded.events.length, 0);
});

/* End users' search text goes to a signed-in member, or to an API key with the content opt-in. */

const OAUTH: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

const CONTENT_CASES = [
  { name: "an API key with the content opt-in off", caller: auth, optIn: false, sees: false },
  { name: "an API key with the content opt-in on", caller: auth, optIn: true, sees: true },
  { name: "a signed-in member, whatever the opt-in", caller: OAUTH, optIn: false, sees: true },
] as const;

for (const { name, caller, optIn, sees } of CONTENT_CASES) {
  test(`quality: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const overrides = { contentOptIn: async () => optIn };
    const misses = ok(await dispatch("get_quality", {}, overrides, caller).result);
    const rewrites = ok(
      await dispatch("list_description_rewrites", { proposalId: PROPOSAL }, overrides, caller)
        .result,
    );
    const byQuery = ok(await dispatch("get_quality", { q: "cancel" }, overrides, caller).result);
    const missData = misses.data as {
      matching: number;
      misses: Array<{ query: string | null; rightTool: { id: string } }>;
      contentWithheld?: true;
    };
    const rewriteData = rewrites.data as {
      pending: Array<{ missed: Array<{ query: string | null; selectionId: string }> }>;
      contentWithheld?: true;
    };
    const queryData = byQuery.data as { misses: unknown[] };

    assert.equal(missData.matching, 3, "every miss is still listed");
    assert.equal(missData.misses[0]!.rightTool.id, "tool-refund");
    assert.equal(rewriteData.pending[0]!.missed.length, 5);
    assert.equal(rewriteData.pending[0]!.missed[0]!.selectionId, "sel-0");
    if (sees) {
      assert.ok(missData.misses.every((row) => typeof row.query === "string"));
      assert.match(rewriteData.pending[0]!.missed[0]!.query ?? "", /money back/);
      assert.equal(queryData.misses.length, 1, "q matches the search text");
      assert.equal(missData.contentWithheld, undefined);
    } else {
      assert.ok(missData.misses.every((row) => row.query === null));
      assert.ok(rewriteData.pending[0]!.missed.every((row) => row.query === null));
      assert.equal(
        queryData.misses.length,
        0,
        "q cannot read the withheld search back a guess at a time",
      );
      assert.equal(missData.contentWithheld, true);
      assert.equal(rewriteData.contentWithheld, true);
      assert.match(misses.hint ?? "", /signed-in members/);
    }
  });
}
