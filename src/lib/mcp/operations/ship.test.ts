import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import type { ShipmentRow } from "@/lib/views/lineage/shipments";
import type { LineageRef } from "@/lib/views/lineage/types";
import type { SessionChat } from "@/lib/views/session-chat/model";
import type { TimelineStep } from "@/lib/views/session-replay/timeline";
import type { SessionView } from "@/lib/views/session-replay/view";
import type { LoadWatchesOptions } from "@/lib/views/ship-monitor/load";
import { buildWatch, type ShipmentWatch } from "@/lib/views/ship-monitor/watch";
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
      turnId: "5c1e0a77-2f4b-4a1e-9d3c-7b2a1f0e9c44",
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
  watchActors: string[];
  watchOptions: LoadWatchesOptions[];
  chats: number;
  /** Whether each view chat read was allowed message text (RC-585). */
  chatText: boolean[];
}

/** A SessionChat as lib/session-chat/load.ts returns one; only its identity matters here. */
function chatOf(sessionId: string): SessionChat {
  return {
    sessionId,
    textOff: false,
    turns: [],
    calls: [],
    segments: [],
    problems: [],
    trackTotalMs: 0,
    realTotalMs: 0,
  };
}

function watchOf(id: string, status: ShipmentWatch["verdict"]["status"]): ShipmentWatch {
  const shipment = {
    id,
    fixId: "craft:x",
    fixKind: "enrich" as const,
    fixTitle: "Return more",
    version: "1.1.0",
    shippedAt: "2026-11-04T23:00:00.000Z",
    tools: ["find_booking", "lookup_reservation"],
  };
  return buildWatch(
    PROJECT,
    shipment,
    {
      before: {
        tools: [
          { toolId: "find_booking", calls: 100, errors: 2, p50Ms: 480 },
          { toolId: "lookup_reservation", calls: 9, errors: 0, p50Ms: 400 },
        ],
        runs: { runs: 90, toolCalls: 300, tokens: 450_000 },
      },
      after: {
        tools: [
          { toolId: "find_booking", calls: 12, errors: 0, p50Ms: 500 },
          {
            toolId: "lookup_reservation",
            calls: status === "regressed" ? 2 : 0,
            errors: 0,
            p50Ms: 400,
          },
        ],
        runs: { runs: status === "watching" ? 4 : 12, toolCalls: 36, tokens: 54_000 },
      },
      traces: Array.from({ length: 12 }, (_, i) => ({
        traceId: `t${i}`,
        startedAt: "2026-11-04T23:30:00.000Z",
        tools: ["find_booking"],
        error: false,
      })),
    },
    new Date("2026-11-05T00:00:00.000Z"),
  );
}

function harness(
  over: Partial<ShipOperationDeps> = {},
  auth: McpAuthContext = keyAuth,
  org: Organization = proOrg,
) {
  const calls: Calls = {
    actors: [],
    trails: 0,
    resolve: [],
    sessionText: [],
    watchActors: [],
    watchOptions: [],
    chats: 0,
    chatText: [],
  };
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
    shipMonitorEnabled: async (_projectId, actor) => {
      calls.watchActors.push(actor);
      return true;
    },
    loadWatches: async (_projectId, options) => {
      calls.watchOptions.push(options);
      const all = [watchOf("ship-2", "regressed"), watchOf("ship-1", "watching")];
      return options.shipmentId
        ? all.filter((watch) => watch.shipment.id === options.shipmentId)
        : all;
    },
    loadSessionChat: async (_projectId, sessionId, mayReadContent) => {
      calls.chats += 1;
      calls.chatText.push(mayReadContent);
      return chatOf(sessionId);
    },
    loadStepContent: async () => ({
      readContent: true,
      content: { calls: {}, query: "fare to Rome" },
    }),
    now: () => new Date("2026-11-05T00:00:00.000Z"),
    ...over,
  };
  const run = (id: string, params: Record<string, unknown> = {}, forView = false) =>
    dispatchOperation(id, params, { registry: buildRegistry(shipOperations(deps)), auth, forView });
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

test("get_session returns the timeline without text unless asked", async () => {
  const { run, calls } = harness();
  const out = data<{
    steps: { text?: unknown; context: unknown; toolChoice: unknown[] }[];
    totals: { costUsd: number };
    whatIf: { tools: { name: string }[] };
  }>(await run("get_session", { sessionId: "sess-1" }));
  assert.deepEqual(calls.sessionText, [null], "no text asked for, none read");
  assert.equal(out.steps.length, 3);
  assert.equal(
    "turnId" in out.steps[0]!,
    false,
    "rows are main's: the replay view reads turn ids from its SessionChat",
  );
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

test("get_session answers the agent when the view's own read fails, without the view", async () => {
  const { run } = harness({
    loadSessionChat: async () => Promise.reject(new Error("statement timeout")),
  });
  const plain = (await run("get_session", { sessionId: "sess-1" })) as DispatchSuccess;
  const forView = (await run("get_session", { sessionId: "sess-1" }, true)) as DispatchSuccess;
  assert.equal(forView.ok, true);
  assert.equal(forView.view, undefined);
  assert.deepEqual(forView.data, plain.data);
});

test("get_session adds the console's SessionChat for its view only, and never to the agent's data", async () => {
  const { run, calls } = harness();
  const plain = (await run("get_session", { sessionId: "sess-1" })) as DispatchSuccess;
  assert.equal(plain.view, undefined);
  assert.equal(calls.chats, 0, "no extra read without a view");

  const forView = (await run("get_session", { sessionId: "sess-1" }, true)) as DispatchSuccess;
  assert.deepEqual(forView.data, plain.data, "the data the agent reads is unchanged");
  const view = forView.view as {
    kind: string;
    projectId: string;
    chat: SessionChat;
    turnIndex: number | null;
    sessionHref: string;
    settingsHref: string;
  };
  assert.equal(view.kind, "session_chat");
  assert.equal(view.chat.sessionId, "sess-1");
  assert.equal(view.turnIndex, null);
  assert.match(view.sessionHref, /\/sessions\/sess-1$/);
  assert.match(view.settingsHref, /\/settings$/);
  assert.deepEqual(calls.chatText, [true], "a key with content:read may see the view's text");

  const readOnly = harness({}, { ...keyAuth, scopes: ["mcp:read"] });
  await readOnly.run("get_session", { sessionId: "sess-1" }, true);
  assert.deepEqual(
    readOnly.calls.chatText,
    [false],
    "a key without content:read reads the view's chat without text (RC-585)",
  );
});

test("get_session_step_content reads the inspector's text, and says when the opt-in is off or the key may not read it", async () => {
  const eventIds = ["0b6c3a52-3f0e-4f4e-9d0a-1c2b3c4d5e6f"];
  const on = harness();
  assert.deepEqual(data(await on.run("get_session_step_content", { eventIds })), {
    contentOptIn: true,
    content: { calls: {}, query: "fare to Rome" },
  });

  const off = harness({ loadStepContent: async () => ({ readContent: false, content: null }) });
  const result = (await off.run("get_session_step_content", { eventIds })) as DispatchSuccess;
  assert.deepEqual(result.data, { contentOptIn: false, content: null });
  assert.match(result.hint ?? "", /content reading/);

  const readOnly = harness(
    { loadStepContent: async () => assert.fail("no stored text is read without content:read") },
    { ...keyAuth, scopes: ["mcp:read"] },
  );
  const withheld = (await readOnly.run("get_session_step_content", {
    eventIds,
  })) as DispatchSuccess;
  assert.deepEqual(
    withheld.data,
    { contentOptIn: false, content: null, contentWithheld: true },
    "an API key without content:read reads no text (RC-585)",
  );
  assert.equal(
    ((await on.run("get_session_step_content", { eventIds: ["not-a-uuid"] })) as { error?: string })
      .error,
    "invalid_params",
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

test("get_shipment_watch: each watched shipment's verdict, changed and removed tools, runs and newest traces", async () => {
  const { run, calls } = harness();
  const out = data<{
    count: number;
    watches: {
      shipmentId: string;
      verdict: { status: string; reasons: string[] };
      removed: { toolId: string; callsAfter: number }[];
      changed: { toolId: string }[];
      runs: { after: { runs: number } };
      traces: { href: string }[];
    }[];
  }>(await run("get_shipment_watch"));
  assert.equal(out.count, 2);
  assert.deepEqual(
    out.watches.map((watch) => [watch.shipmentId, watch.verdict.status]),
    [
      ["ship-2", "regressed"],
      ["ship-1", "watching"],
    ],
  );
  assert.deepEqual(out.watches[0]!.removed, [
    { toolId: "lookup_reservation", callsAfter: 2, baselineCalls: 9, flagged: true },
  ]);
  assert.equal(out.watches[0]!.changed[0]!.toolId, "find_booking");
  assert.ok(out.watches[0]!.traces.length <= 5, "a few traces per watch");
  assert.equal(out.watches[0]!.traces[0]!.href, `/project/${PROJECT}/traces/t0`);
  assert.deepEqual(calls.watchActors, [`project:${PROJECT}`]);
});

test("get_shipment_watch with a shipmentId reads that one, or not found", async () => {
  const { run, calls } = harness();
  const one = data<{ watches: { shipmentId: string }[] }>(
    await run("get_shipment_watch", { shipmentId: "ship-1" }),
  );
  assert.deepEqual(
    one.watches.map((watch) => watch.shipmentId),
    ["ship-1"],
  );
  assert.equal(calls.watchOptions[0]!.shipmentId, "ship-1");
  const missing = await run("get_shipment_watch", { shipmentId: "ship-99" });
  assert.equal(missing.ok === false && missing.error, "not_found");
});

test("get_shipment_watch refuses when the ship watch is off for the caller", async () => {
  const { run, calls } = harness({ shipMonitorEnabled: async () => false });
  const out = await run("get_shipment_watch");
  assert.equal(out.ok === false && out.error, "forbidden");
  assert.deepEqual(calls.watchOptions, []);
});
