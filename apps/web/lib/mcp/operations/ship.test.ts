import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import type { ShipmentRow } from "@/lib/views/lineage/shipments";
import type { LineageRef } from "@/lib/views/lineage/types";
import type { TimelineStep } from "@/lib/views/session-replay/timeline";
import type { SessionView } from "@/lib/views/session-replay/view";
import {
  type LoadedSession,
  type ShipOperationDeps,
  type StepWindow,
  shipOperations,
  textCallsInWindow,
} from "./ship";

/**
 * Ship, lineage, freshness and session replay over MCP against injected reads:
 * each flag decided for the bearer's actor, the plan's say over whether an
 * insight names its run, trails only for the newest shipments, and message
 * text only with the project's content opt-in.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const keyAuth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "free" },
};

const oauth: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "admin",
      organization: { id: "org-1", slug: "acme", effectivePlan: "free" },
    },
  ],
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

function shipment(i: number): ShipmentRow {
  const ref: LineageRef = {
    stage: "ship",
    kind: "shipment",
    id: `ship-${i}`,
    label: `Fix ${i} shipped`,
    href: `/project/${PROJECT}/ship?peek=ship-${i}`,
  };
  return {
    ref,
    title: `Fix ${i} shipped`,
    shippedAt: `2026-11-0${Math.min(9, i)}T00:00:00.000Z`,
    source: { stage: "improve", kind: "fix", id: `issue:${i}` },
  };
}

function sessionView(rows: number): SessionView {
  return {
    sessionId: "sess-1",
    rows: Array.from({ length: rows }, (_, index) => ({
      index,
      kind: index === 0 ? "turn" : "model_call",
      turnIndex: 1,
      title: index === 0 ? "Turn 1" : "Model call · gpt",
      detail: null,
      at: "2026-11-01T00:00:00.000Z",
      coverage: "content",
      marks: [],
      bar:
        index === 0
          ? null
          : {
              total: 1000,
              segments: [{ part: "history", label: "History", tokens: 600, share: 0.6 }],
            },
      markers: [],
      chips: [
        { tone: "good", text: "At step 1 the agent picked find_fare, the top search result." },
      ],
      lensStep: index === 0 ? null : index,
    })) as SessionView["rows"],
    totals: {
      turns: 1,
      modelCalls: rows - 1,
      toolCalls: 0,
      inputTokens: 1000,
      costUsd: 0.0123456789,
    },
    coverage: {
      counts: { content: rows, tokens_only: 0, expired: 0 },
      text: "Of 3 steps, 3 have content.",
      tone: "info",
    },
    gaps: [],
  };
}

function loaded(readContent: boolean, rows = 3): LoadedSession {
  return {
    view: sessionView(rows),
    readContent,
    texts: {
      1: {
        system: "s".repeat(900),
        messages: [
          { role: "user", text: "a" },
          { role: "assistant", text: "b" },
          { role: "user", text: "c" },
          { role: "user", text: "d" },
        ],
        omitted: 0,
      },
    },
    forkableCalls: rows - 1,
    tools: ["find_fare"],
    runs: [],
  };
}

interface Calls {
  actors: string[];
  trails: number;
  resolve: { ref: LineageRef; traces: boolean; chain: boolean }[];
  sessionText: (StepWindow | null)[];
}

function harness(
  over: Partial<ShipOperationDeps> = {},
  auth: McpAuthContext = keyAuth,
  org: Organization = proOrg,
) {
  const calls: Calls = { actors: [], trails: 0, resolve: [], sessionText: [] };
  const deps: ShipOperationDeps = {
    getOrganization: async () => org,
    evalGateEnabled: async (_projectId, actor) => {
      calls.actors.push(actor);
      return false;
    },
    loadShipments: async () => Array.from({ length: 7 }, (_, i) => shipment(i + 1)),
    shipmentTrail: async (row) => {
      calls.trails += 1;
      return [{ stage: "monitor", kind: "trace", id: "t1" }, row.source!, row.ref];
    },
    resolveLineage: async (ref, ctx, chain) => {
      calls.resolve.push({ ref, traces: ctx.traces, chain });
      return chain
        ? [{ stage: "monitor", kind: "metric", id: "first_try" }, ref]
        : { stage: "monitor", kind: "metric", id: "first_try" };
    },
    loadFreshness: async (_projectId, section) => ({
      freshness: { updatedAt: "2026-11-04T23:50:00.000Z", working: true, importing: null },
      progress: section ? { lastDoneAt: "2026-11-04T23:00:00.000Z", pending: 2 } : null,
    }),
    sessionReplayEnabled: async (_projectId, actor) => {
      calls.actors.push(actor);
      return true;
    },
    loadSession: async (_projectId, _sessionId, textWindow) => {
      calls.sessionText.push(textWindow);
      return loaded(true);
    },
    loadWhatIfOptions: async () => ({
      fixes: [{ id: "issue:1", title: "Retry", craft: false }],
      tools: [
        { name: "zeta", description: "", searchable: "z" },
        { name: "find_fare", description: "", searchable: "f".repeat(300) },
      ],
    }),
    now: () => new Date("2026-11-05T00:00:00.000Z"),
    ...over,
  };
  const run = (id: string, params: Record<string, unknown> = {}) =>
    dispatchOperation(id, params, { registry: buildRegistry(shipOperations(deps)), auth });
  return { run, calls };
}

function data<T>(result: DispatchResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

test("list_shipments walks trails for the newest few only", async () => {
  const { run, calls } = harness();
  const out = data<{ count: number; shipments: { id: string; trail: LineageRef[] | null }[] }>(
    await run("list_shipments"),
  );
  assert.equal(out.count, 7);
  assert.equal(calls.trails, 5);
  assert.equal(out.shipments[0]!.trail!.length, 3);
  assert.equal(out.shipments[6]!.trail, null);
  assert.deepEqual(calls.actors, [`project:${PROJECT}`]);
});

test("list_shipments with a shipmentId returns that one, or not found", async () => {
  const { run } = harness();
  const one = data<{ shipments: { id: string }[] }>(
    await run("list_shipments", { shipmentId: "ship-6" }),
  );
  assert.deepEqual(
    one.shipments.map((row) => row.id),
    ["ship-6"],
  );
  const missing = await run("list_shipments", { shipmentId: "ship-99" });
  assert.equal(missing.ok === false && missing.error, "not_found");
});

test("Ship and lineage work for an OAuth user with no stage flag, deciding only the eval step for them", async () => {
  const { run, calls } = harness({}, oauth);
  const shipments = data<{ count: number }>(await run("list_shipments", { projectId: PROJECT }));
  assert.equal(shipments.count, 7);
  const lineage = data<{ source: LineageRef }>(
    await run("get_lineage", { projectId: PROJECT, kind: "insight", id: "x" }),
  );
  assert.equal(lineage.source.kind, "metric");
  assert.deepEqual(calls.actors, ["user_abc"]);
});

test("get_lineage resolves one step back, with the plan deciding whether an insight names its run", async () => {
  const { run, calls } = harness({}, keyAuth, freeOrg);
  const out = data<{ ref: LineageRef; source: LineageRef }>(
    await run("get_lineage", { kind: "insight", id: "22222222-2222-4222-8222-222222222222" }),
  );
  assert.equal(out.ref.stage, "insights");
  assert.equal(out.source.kind, "metric");
  assert.equal(calls.resolve[0]!.traces, false);
  assert.equal(calls.resolve[0]!.chain, false);
});

test("get_lineage with chain returns the chain oldest first; an unknown kind is invalid", async () => {
  const { run, calls } = harness();
  const out = data<{ chain: LineageRef[] }>(
    await run("get_lineage", { kind: "fix", id: "issue:1", chain: true }),
  );
  assert.equal(out.chain.at(-1)!.id, "issue:1");
  assert.equal(calls.resolve[0]!.traces, true);
  const bad = await run("get_lineage", { kind: "release", id: "x" });
  assert.equal(bad.ok === false && bad.error, "invalid_params");
});

test("get_analysis_freshness reports the project and one section", async () => {
  const { run } = harness();
  const result = await run("get_analysis_freshness", { section: "intents" });
  const out = data<{
    working: boolean;
    line: string | null;
    section: { name: string; pending: number; jobKinds: string[] };
  }>(result);
  assert.equal(out.working, true);
  assert.equal(typeof out.line, "string");
  assert.equal(out.section.pending, 2);
  assert.ok(out.section.jobKinds.includes("assign_topics"));
  assert.match((result as DispatchSuccess).hint ?? "", /Poll again/);
});

test("get_analysis_freshness rejects an unknown section", async () => {
  const { run } = harness();
  const result = await run("get_analysis_freshness", { section: "billing" });
  assert.equal(result.ok === false && result.error, "invalid_params");
});

test("get_session is forbidden when session replay is off for the caller", async () => {
  const { run } = harness({ sessionReplayEnabled: async () => false });
  const result = await run("get_session", { sessionId: "sess-1" });
  assert.equal(result.ok === false && result.error, "forbidden");
  assert.equal(result.ok === false && result.reason, "session_replay_off");
});

test("get_session returns the timeline without text unless asked", async () => {
  const { run, calls } = harness();
  const out = data<{
    steps: { text?: unknown; context: unknown; toolChoice: unknown[] }[];
    totals: { costUsd: number };
    whatIf: { tools: { name: string }[] };
  }>(await run("get_session", { sessionId: "sess-1" }));
  assert.deepEqual(calls.sessionText, [null], "no text asked for, none read");
  assert.equal(out.steps.length, 3);
  assert.equal(out.steps[1]!.text, undefined);
  assert.equal(out.totals.costUsd, 0.012346);
  assert.deepEqual(
    out.whatIf.tools.map((tool) => tool.name),
    ["find_fare", "zeta"],
  );
});

test("get_session shows message text only with the content opt-in, cut short", async () => {
  const on = harness();
  const result = await on.run("get_session", { sessionId: "sess-1", includeText: true });
  const out = data<{
    steps: { text?: { system: string; messages: unknown[]; omitted: number } }[];
  }>(result);
  const text = out.steps[1]!.text!;
  assert.equal(text.system.length, 401);
  assert.equal(text.messages.length, 3);
  assert.equal(text.omitted, 1);
  assert.equal(result.ok && result.truncated, true);

  const off = harness({ loadSession: async () => loaded(false) });
  const hidden = data<{ steps: { text?: unknown }[]; contentOptIn: boolean }>(
    await off.run("get_session", { sessionId: "sess-1", includeText: true }),
  );
  assert.equal(hidden.contentOptIn, false);
  assert.equal(hidden.steps[1]!.text, undefined);
});

test("get_session pages through a long session", async () => {
  const { run } = harness({ loadSession: async () => loaded(true, 10) });
  const result = await run("get_session", { sessionId: "sess-1", offset: 2, steps: 3 });
  const out = data<{ steps: { index: number }[]; stepCount: number }>(result);
  assert.deepEqual(
    out.steps.map((step) => step.index),
    [2, 3, 4],
  );
  assert.equal(out.stepCount, 10);
  assert.equal(result.ok && result.truncated, true);
  assert.match((result as DispatchSuccess).hint ?? "", /offset 5/);
});

test("an unknown session is not found", async () => {
  const { run } = harness({ loadSession: async () => null });
  const result = await run("get_session", { sessionId: "nope" });
  assert.equal(result.ok === false && result.error, "not_found");
});

test("get_session asks for text of the returned window only", async () => {
  const { run, calls } = harness({
    loadSession: async (_projectId, _sessionId, textWindow) => {
      calls.sessionText.push(textWindow);
      return loaded(true, 10);
    },
  });
  data(await run("get_session", { sessionId: "sess-1", includeText: true, offset: 4, steps: 3 }));
  assert.deepEqual(calls.sessionText, [{ offset: 4, steps: 3 }]);
});

test("textCallsInWindow reads only the window's model calls that kept their text", () => {
  const view = sessionView(8);
  const step = (
    index: number,
    kind: TimelineStep["kind"],
    coverage: "content" | "tokens_only" = "content",
  ) =>
    ({
      index,
      kind,
      coverage,
      eventId: `event-${index}`,
      turnId: "turn-1",
      turnIndex: 1,
      at: "2026-11-01T00:00:00.000Z",
      marks: [],
    }) as unknown as TimelineStep;
  const steps = [
    step(0, "turn"),
    ...[1, 2, 3, 4, 5, 6, 7].map((index) =>
      step(index, "model_call", index === 4 ? "tokens_only" : "content"),
    ),
  ];

  assert.deepEqual(textCallsInWindow(view, steps, { offset: 3, steps: 3 }), [
    { index: 3, eventId: "event-3" },
    { index: 5, eventId: "event-5" },
  ]);
  assert.deepEqual(
    textCallsInWindow(view, steps, { offset: 0, steps: 1 }),
    [],
    "the window holds only the turn",
  );
  assert.deepEqual(
    textCallsInWindow(view, steps, { offset: 20, steps: 5 }),
    [],
    "past the end reads nothing",
  );
});

test("get_session withholds message text from an API key without the content scope, even with the opt-in on (RC-585)", async () => {
  const readOnly = { ...keyAuth, scopes: ["mcp:read"] };
  const { run, calls } = harness({}, readOnly);
  const out = data<{ steps: { text?: unknown }[]; contentWithheld?: boolean }>(
    await run("get_session", { sessionId: "sess-1", includeText: true }),
  );
  assert.deepEqual(calls.sessionText, [null], "no text window is even read");
  assert.equal(out.steps[1]!.text, undefined);
  assert.equal(out.contentWithheld, true);

  const withScope = harness({}, { ...keyAuth, scopes: ["mcp:read", "content:read"] });
  const shown = data<{ steps: { text?: unknown }[] }>(
    await withScope.run("get_session", { sessionId: "sess-1", includeText: true }),
  );
  assert.ok(shown.steps[1]!.text, "with content:read and the opt-in, text is shown");
});
