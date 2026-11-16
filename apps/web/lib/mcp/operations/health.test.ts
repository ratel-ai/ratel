import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import type { TraceSignalRow } from "@/lib/readings/trace-signals/schema";
import type { HealthPageModel, SignalView } from "@/lib/readings/trace-signals/view";
import type { IssueExamples } from "@/lib/views/health/issue-examples";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import type { PageStateInput } from "@/lib/views/health/page-state-load";
import { unavailableSelfCorrectionsCard } from "@/lib/views/health/self-corrections/card";
import type { SelfCorrectionsPageModel } from "@/lib/views/health/self-corrections/page-model";
import { type HealthOperationDeps, healthOperations } from "./health";
import { shownOpenSignals } from "./loop/read";

/**
 * Agent health over MCP against injected reads: the page's plan cuts (issues,
 * window, example turns), the read never asking for work, the gate, and each
 * write emitting its event with surface "mcp".
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SIGNAL = "22222222-2222-4222-8222-222222222222";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "free" },
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

const freeOrg = {
  id: "org-1",
  slug: "acme",
  plan: "free",
  subscriptionStatus: null,
  planOverride: null,
  limitOverrides: PLAN_LIMITS.free,
} as unknown as Organization;
const proOrg = {
  ...freeOrg,
  planOverride: "pro",
  limitOverrides: PLAN_LIMITS.pro,
} as unknown as Organization;

function signal(i: number, over: Partial<SignalView> = {}): SignalView {
  return {
    id: `${SIGNAL.slice(0, -1)}${i}`,
    kind: "latency_outlier",
    tier: "deterministic",
    status: "open",
    subject: {
      kind: "tool",
      key: "render_video",
      label: "render_video",
      chips: [{ id: "render_video", label: "render_video", entryKind: "tool" }],
    },
    claim: "render_video takes 12.4 s at the median.",
    claimSegments: [],
    figure: { value: 12_400, unit: "ms", display: "12.4 s", raw: "41 calls" },
    severity: 0.512345678,
    impact: 41,
    cost: "About 8 minutes of waiting this week.",
    n: 41,
    interval: null,
    fix: "Run it in the background.",
    fixRoute: "none",
    caveat: null,
    turnSourceMix: { declared: 41, inferred: 0, otlp: 0 },
    evidence: { chart: null, turns: [], totalTurns: 41 },
    firstSeenAt: "2026-10-20T00:00:00.000Z",
    lastSeenAt: "2026-10-30T00:00:00.000Z",
    ...over,
  };
}

function model(signals: SignalView[]): HealthPageModel {
  return {
    ...pendingHealthModel(7),
    turns: 400,
    computedAt: "2026-11-01T00:00:00.000Z",
    signals,
    dismissed: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "wait_heavy",
        toolId: "deploy",
        label: "Deploy",
      },
    ],
  };
}

const selfCorrections: SelfCorrectionsPageModel = {
  projectId: PROJECT,
  state: "ready",
  windowDays: 7,
  computedAt: "2026-11-01T00:00:00.000Z",
  filters: [],
  turns: 200,
  events: 12,
  stats: [{ label: "Per 100 turns", value: "6.0", hint: "" }],
  trend: null,
  byKind: [],
  byTool: [],
  withoutTool: 0,
  byTask: [],
  unplaced: { events: 0, turns: 0 },
  byTopic: null,
  phrases: {
    captured: false,
    top: [{ phrase: "let me try that again", kindLabel: "Apologized", events: 4, share: 0.3 }],
  },
  examples: [],
  fixes: [],
};

interface Calls {
  events: { name: string; context: unknown; properties: Record<string, unknown> }[];
  pageState: PageStateInput[];
  examples: number;
  dismissed: unknown[];
  drained: string[];
  scPage: unknown[];
}

function harness(
  over: Partial<HealthOperationDeps> = {},
  org: Organization = proOrg,
  caller: McpAuthContext = auth,
) {
  const calls: Calls = {
    events: [],
    pageState: [],
    examples: 0,
    dismissed: [],
    drained: [],
    scPage: [],
  };
  const deps: HealthOperationDeps = {
    getOrganization: async () => org,
    agentHealthEnabled: async () => true,
    loadHealthModel: async () => model([signal(1), signal(2), signal(3), signal(4), signal(5)]),
    listImports: async () => [],
    loadPageState: async (input) => {
      calls.pageState.push(input);
      return { kind: "ready" };
    },
    readIssueExamples: async () => {
      calls.examples += 1;
      return [];
    },
    setSignalDismissed: async (input) => {
      calls.dismissed.push(input);
      return { id: input.signalId, kind: "latency_outlier" };
    },
    requestHealthReading: async (_input, overrides = {}) => {
      await overrides.enqueueBuild?.(PROJECT, "manual");
      await overrides.trackServerEvent?.(
        "trace_signal_run_requested",
        { distinctId: "system:agent-health" },
        { trigger: "manual", source: "health_page" },
      );
      return true;
    },
    enqueueBuild: async () => ({ id: "job-build" }),
    enqueueAssignTopicsJob: async () => ({ id: "job-topics" }),
    scheduleProjectDrain: (projectId) => void calls.drained.push(projectId),
    loadSelfCorrectionsPage: async (request) => {
      calls.scPage.push(request);
      return selfCorrections;
    },
    loadSelfCorrectionsCard: async (projectId, windowDays) =>
      unavailableSelfCorrectionsCard(projectId, windowDays),
    trackServerEvent: async (name, context, properties = {}) =>
      void calls.events.push({ name, context, properties }),
    now: () => new Date("2026-11-05T00:00:00.000Z"),
    lastTopicReadingActivity: async () => null,
    contentOptIn: async () => true,
    ...over,
  };
  const run = (id: string, params: Record<string, unknown> = {}) =>
    dispatchOperation(
      id,
      { projectId: PROJECT, ...params },
      { registry: buildRegistry(healthOperations(deps)), auth: caller },
    );
  return { run, calls };
}

function data<T>(result: DispatchResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

test("get_agent_health returns the page's summary and never asks for a reading", async () => {
  const { run, calls } = harness();
  const out = data<{
    windowDays: number;
    openIssueCount: number;
    issues: { id: string; title: string; severity: number; hideable: boolean }[];
    hiddenIssues: { id: string }[];
    state: { kind: string };
    imports: unknown[];
  }>(await run("get_agent_health", { windowDays: 30 }));

  assert.equal(out.windowDays, 30);
  assert.equal(out.openIssueCount, 5);
  assert.equal(out.issues.length, 5);
  assert.equal(out.issues[0]!.severity, 0.5123);
  assert.equal(out.issues[0]!.hideable, true);
  assert.equal(out.hiddenIssues.length, 1);
  assert.equal(out.state.kind, "ready");
  assert.deepEqual(out.imports, []);
  assert.equal(calls.pageState[0]!.readOnly, true);
});

test("get_agent_health cuts issues and the window to the plan, as the page does", async () => {
  const { run } = harness({}, freeOrg);
  const result = await run("get_agent_health", { windowDays: 90 });
  const out = data<{
    windowDays: number;
    requestedWindowDays: number;
    issues: unknown[];
    lockedIssueCount: number;
    openIssueCount: number;
    windowOptions: number[];
  }>(result);

  assert.equal(out.windowDays, 7);
  assert.equal(out.requestedWindowDays, 90);
  assert.deepEqual(out.windowOptions, [7]);
  assert.equal(out.issues.length, 3);
  assert.equal(out.lockedIssueCount, 2);
  assert.equal(out.openIssueCount, 5);
});

test("a reading that failed to load reads as unavailable, not as an empty project", async () => {
  const { run, calls } = harness({ loadHealthModel: async () => null });
  data(await run("get_agent_health", {}));
  assert.equal(calls.pageState[0]!.modelUnavailable, true);
});

test("get_agent_health limits the issue list and marks it truncated", async () => {
  const { run } = harness();
  const result = await run("get_agent_health", { limit: 2 });
  assert.equal(data<{ issues: unknown[] }>(result).issues.length, 2);
  assert.equal(result.ok && result.truncated, true);
});

test("Agent health off for the project refuses as forbidden", async () => {
  const { run } = harness({ agentHealthEnabled: async () => false });
  const result = await run("get_agent_health", {});
  assert.equal(result.ok === false && result.error, "forbidden");
  assert.equal(result.ok === false && result.reason, "agent_health_off");
});

test("list_issue_examples on a plan without examples reads nothing", async () => {
  const { run, calls } = harness({}, freeOrg);
  const out = data<{ locked: boolean; examples: unknown[] }>(
    await run("list_issue_examples", { issueIds: [SIGNAL] }),
  );
  assert.equal(out.locked, true);
  assert.equal(calls.examples, 0);
});

test("list_issue_examples cuts a captured search short and passes the plan's limits", async () => {
  let limits: unknown = null;
  const example: IssueExamples = {
    id: SIGNAL,
    total: 9,
    turns: [
      {
        turnId: "turn-1",
        traceId: "trace-1",
        startedAt: "2026-11-01T00:00:00.000Z",
        turnSource: "declared",
        steps: [
          { kind: "search", query: { state: "captured", text: "x".repeat(500) }, listed: 10 },
          {
            kind: "invoke",
            toolId: "render_video",
            pickedRank: 2,
            outcome: "ok",
            tookMs: 12_000,
            flag: { label: "slow" },
          },
        ],
      },
    ],
  };
  const { run } = harness({
    readIssueExamples: async (_projectId, _ids, value) => {
      limits = value;
      return [example];
    },
  });
  const result = await run("list_issue_examples", { issueIds: [SIGNAL] });
  const out = data<{
    examples: { turns: { steps: { query?: string; flag: string | null }[]; href: string }[] }[];
  }>(result);
  const steps = out.examples[0]!.turns[0]!.steps;

  assert.deepEqual(limits, { perIssue: 6, shown: Infinity });
  assert.equal(steps[0]!.query!.length, 201);
  assert.equal(steps[1]!.flag, "slow");
  assert.equal(result.ok && result.truncated, true);
});

test("set_health_signal_hidden hides as the key's actor and emits its event with surface mcp", async () => {
  const { run, calls } = harness();
  const out = data<{ hidden: boolean }>(
    await run("set_health_signal_hidden", { signalId: SIGNAL, hidden: true }),
  );

  assert.equal(out.hidden, true);
  assert.deepEqual(calls.dismissed[0], {
    projectId: PROJECT,
    signalId: SIGNAL,
    kinds: ["latency_outlier", "wait_heavy"],
    dismissed: true,
    by: `project:${PROJECT}`,
  });
  assert.equal(calls.events[0]!.name, "health_signal_dismissed");
  assert.equal(calls.events[0]!.properties.surface, "mcp");
  assert.equal(calls.events[0]!.properties.reason, "slow_by_design");
});

test("showing an issue again emits health_signal_restored", async () => {
  const { run, calls } = harness();
  data(await run("set_health_signal_hidden", { signalId: SIGNAL, hidden: false }));
  assert.equal(calls.events[0]!.name, "health_signal_restored");
  assert.equal(calls.events[0]!.properties.surface, "mcp");
});

test("an issue that cannot be hidden is not found, and nothing is emitted", async () => {
  const { run, calls } = harness({ setSignalDismissed: async () => null });
  const result = await run("set_health_signal_hidden", { signalId: SIGNAL, hidden: true });
  assert.equal(result.ok === false && result.error, "not_found");
  assert.equal(calls.events.length, 0);
});

test("request_analysis for health returns the build's job id and re-attributes its event to MCP", async () => {
  const { run, calls } = harness();
  const out = data<{ queued: boolean; jobId: string }>(
    await run("request_analysis", { what: "health" }),
  );

  assert.equal(out.queued, true);
  assert.equal(out.jobId, "job-build");
  assert.equal(calls.events[0]!.name, "trace_signal_run_requested");
  assert.equal(calls.events[0]!.properties.surface, "mcp");
  assert.equal(calls.events[0]!.properties.source, "mcp");
  assert.deepEqual(calls.events[0]!.context, { projectId: PROJECT, orgId: "org-1" });
});

test("request_analysis for health inside the cooldown says so and queues nothing", async () => {
  const { run } = harness({ requestHealthReading: async () => false });
  const out = data<{ queued: boolean; reason: string; retryAfterSeconds: number }>(
    await run("request_analysis", { what: "health" }),
  );
  assert.equal(out.queued, false);
  assert.equal(out.reason, "cooldown");
  assert.equal(out.retryAfterSeconds, 600);
});

test("request_analysis for health reports a failed enqueue as an error", async () => {
  const { run } = harness({
    enqueueBuild: async () => {
      throw new Error("db down");
    },
    requestHealthReading: async (_input, overrides = {}) => {
      try {
        await overrides.enqueueBuild?.(PROJECT, "manual");
        return true;
      } catch {
        return false;
      }
    },
  });
  const result = await run("request_analysis", { what: "health" });
  assert.equal(result.ok === false && result.error, "internal");
});

test("request_analysis for intents queues a reading, drains, and emits topic_run_requested", async () => {
  const { run, calls } = harness();
  const out = data<{ jobId: string; coalesced: boolean }>(
    await run("request_analysis", { what: "intents" }),
  );
  assert.equal(out.jobId, "job-topics");
  assert.equal(out.coalesced, false);
  assert.deepEqual(calls.drained, [PROJECT]);
  assert.equal(calls.events[0]!.name, "topic_run_requested");
  assert.equal(calls.events[0]!.properties.surface, "mcp");
});

test("get_self_corrections passes filters through and hides phrases the console would not show", async () => {
  const { run, calls } = harness({}, freeOrg);
  const out = data<{ phrases: unknown; events: number; requestedWindowDays: number }>(
    await run("get_self_corrections", { windowDays: 30, tool: "render_video", intent: "topic-1" }),
  );
  assert.deepEqual(calls.scPage[0], {
    projectId: PROJECT,
    windowDays: 7,
    filters: { tool: "render_video", task: null, topic: "topic-1" },
  });
  assert.equal(out.phrases, null);
  assert.equal(out.events, 12);
  assert.equal(out.requestedWindowDays, 30);
});

test("get_self_corrections shows captured phrases, cut short", async () => {
  const captured = {
    ...selfCorrections,
    phrases: {
      captured: true,
      top: [{ phrase: "y".repeat(300), kindLabel: "Apologized", events: 4, share: 0.3 }],
    },
  };
  const { run } = harness({ loadSelfCorrectionsPage: async () => captured });
  const result = await run("get_self_corrections", {});
  const out = data<{ phrases: { phrase: string }[] }>(result);
  assert.equal(out.phrases[0]!.phrase.length, 121);
  assert.equal(result.ok && result.truncated, true);
});

/* - list_insights' plan cut (loop/read.ts) ----------------------------------- */

function row(i: number, kind = "latency_outlier"): TraceSignalRow {
  return {
    id: `${SIGNAL.slice(0, -1)}${i}`,
    kind,
    subjectKind: "tool",
    subjectKey: "render_video",
    subject: {},
    tier: "deterministic",
    status: "open",
    severity: 0.5,
    impact: 1,
    n: 1,
    metrics: {},
    evidence: {},
    firstSeenAt: new Date("2026-10-20T00:00:00.000Z"),
    lastSeenAt: new Date("2026-10-30T00:00:00.000Z"),
  } as unknown as TraceSignalRow;
}

test("list_insights shows no more issues than Agent health does on the plan", async () => {
  const rows = [row(1, "not_a_kind"), row(2), row(3), row(4), row(5), row(6)];
  const free = await shownOpenSignals(PROJECT, {
    getOrganization: async () => freeOrg,
    enabled: async () => true,
    listOpen: async () => rows,
  });
  const pro = await shownOpenSignals(PROJECT, {
    getOrganization: async () => proOrg,
    enabled: async () => true,
    listOpen: async () => rows,
  });
  const off = await shownOpenSignals(PROJECT, {
    getOrganization: async () => proOrg,
    enabled: async () => false,
    listOpen: async () => rows,
  });

  // The row the page cannot put in words is left out before the cut, as on the page.
  assert.deepEqual(
    free.map((r) => r.id.slice(-1)),
    ["2", "3", "4"],
  );
  assert.equal(pro.length, 5);
  assert.equal(off.length, 0);
});

/* - captured text: search words and the agent's phrases ---------------------- */

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

const capturedCorrections: SelfCorrectionsPageModel = {
  ...selfCorrections,
  phrases: {
    captured: true,
    top: [{ phrase: "sorry, let me fix that", kindLabel: "Apologized", events: 4, share: 0.3 }],
  },
  examples: [
    {
      id: "ex-1",
      kindLabel: "Apologized",
      phrase: "sorry, let me fix that",
      hasText: true,
      summary: "The agent said “sorry, let me fix that”.",
      context: "After Render video",
      occurredAt: "2026-11-01T00:00:00.000Z",
      traceHref: `/project/${PROJECT}/traces/trace-1`,
    },
  ],
};

const searchExample: IssueExamples = {
  id: SIGNAL,
  total: 1,
  turns: [
    {
      turnId: "turn-1",
      traceId: "trace-1",
      startedAt: "2026-11-01T00:00:00.000Z",
      turnSource: "declared",
      steps: [
        { kind: "search", query: { state: "captured", text: "refund my order 1234" }, listed: 10 },
        {
          kind: "invoke",
          toolId: "render_video",
          pickedRank: 2,
          outcome: "ok",
          tookMs: 12_000,
          flag: { label: "slow" },
        },
      ],
    },
  ],
};

for (const { name, caller, optIn, sees } of CONTENT_CASES) {
  test(`health: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const { run } = harness(
      {
        contentOptIn: async () => optIn,
        loadSelfCorrectionsPage: async () => capturedCorrections,
        readIssueExamples: async () => [searchExample],
      },
      proOrg,
      caller,
    );
    const corrections = await run("get_self_corrections", {});
    const examples = await run("list_issue_examples", { issueIds: [SIGNAL] });
    const sc = data<{
      phrases: { phrase: string }[] | null;
      examples: { phrase: string | null; summary: string; context: string }[];
      events: number;
      contentWithheld?: true;
    }>(corrections);
    const ex = data<{
      examples: {
        turns: { steps: { query?: string | null; queryState?: string; flag: string | null }[] }[];
      }[];
      contentWithheld?: true;
    }>(examples);
    const steps = ex.examples[0]!.turns[0]!.steps;

    assert.equal(sc.events, 12, "the counts stay");
    assert.equal(sc.examples[0]!.context, "After Render video");
    assert.equal(steps[0]!.queryState, "captured");
    assert.equal(steps[1]!.flag, "slow");
    if (sees) {
      assert.deepEqual(
        sc.phrases?.map((row) => row.phrase),
        ["sorry, let me fix that"],
      );
      assert.equal(sc.examples[0]!.phrase, "sorry, let me fix that");
      assert.match(sc.examples[0]!.summary, /sorry, let me fix that/);
      assert.equal(steps[0]!.query, "refund my order 1234");
      assert.equal(sc.contentWithheld, undefined);
      assert.equal(ex.contentWithheld, undefined);
    } else {
      assert.equal(sc.phrases, null);
      assert.equal(sc.examples[0]!.phrase, null);
      assert.equal(
        sc.examples[0]!.summary,
        "The agent corrected itself.",
        "the summary does not quote the phrase either",
      );
      assert.equal(steps[0]!.query, null);
      assert.equal(sc.contentWithheld, true);
      assert.equal(ex.contentWithheld, true);
      for (const result of [corrections, examples])
        assert.match(result.ok ? (result.hint ?? "") : "", /signed-in members/);
    }
  });
}

/* - request_analysis for intents: the cooldown ------------------------------- */

test("request_analysis for intents inside the cooldown queues nothing and says when to retry", async () => {
  const since: Date[] = [];
  const { run, calls } = harness({
    // A reading finished four minutes before "now" (2026-11-05T00:00:00Z).
    lastTopicReadingActivity: async (_projectId, from) => {
      since.push(from);
      return new Date("2026-11-04T23:56:00.000Z");
    },
    enqueueAssignTopicsJob: async () => {
      throw new Error("must not enqueue inside the cooldown");
    },
  });
  const out = data<{ queued: boolean; reason: string; retryAfterSeconds: number }>(
    await run("request_analysis", { what: "intents" }),
  );

  assert.equal(out.queued, false);
  assert.equal(out.reason, "cooldown");
  assert.equal(out.retryAfterSeconds, 360);
  assert.equal(since[0]!.toISOString(), "2026-11-04T23:50:00.000Z", "it looks back ten minutes");
  assert.deepEqual(calls.drained, []);
  assert.equal(calls.events.length, 0);
});

test("request_analysis for intents after the cooldown queues as before", async () => {
  const { run, calls } = harness({ lastTopicReadingActivity: async () => null });
  const out = data<{ queued: boolean; jobId: string }>(
    await run("request_analysis", { what: "intents" }),
  );
  assert.equal(out.queued, true);
  assert.equal(out.jobId, "job-topics");
  assert.deepEqual(calls.drained, [PROJECT]);
});
