import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { EvalGatePageModel } from "@/lib/views/eval-gate/page-model";
import type { FixEvalSetRow } from "@/lib/views/eval-gate/schema";
import type { EvalCase } from "@/lib/views/eval-gate/types";
import { fixStats } from "@/lib/views/fixes/select";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import {
  defaultFixEvalSetDeps,
  type FixEvalSetDeps,
  loopEvalSetReadOperations,
  loopEvalSetWriteOperations,
} from "./eval-sets";

/**
 * A fix's eval set and Dismiss as tools: each edit reaches the `lib/eval-gate`
 * call the console's eval actions make, behind the eval gate, with the
 * console's event names and surface "mcp"; reads are capped for a context
 * window.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SET = "22222222-2222-4222-8222-222222222222";
const CASE = "33333333-3333-4333-8333-333333333333";
const PROPOSAL = "44444444-4444-4444-8444-444444444444";
const FIX = `craft:${PROPOSAL}`;
const ACTOR = `project:${PROJECT}`;

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const fix: Fix = {
  id: FIX,
  source: "craft",
  sourceId: PROPOSAL,
  aliases: [FIX],
  title: "Merge find and hold",
  short: "Merge two tools",
  why: "Two calls.",
  kind: "merge",
  kindLabel: "Merge",
  group: "agent" as Fix["group"],
  status: "open",
  subject: {
    tools: [{ id: "find_flight", label: "find_flight", href: "/catalog" }],
    tasks: [],
    topics: [],
  },
  effect: null,
  gain: null,
  evidence: null,
  issues: [],
  actions: {
    apply: false,
    dismiss: true,
    revert: false,
    catalogHref: null,
    copy: null,
    descriptionHref: null,
  },
  detail: { source: "issue", changes: [], caveat: null },
  rank: { tier: 1, score: 1, count: 1 },
  appliedAt: null,
};
const issueFix: Fix = {
  ...fix,
  id: "issue:55555555-5555-4555-8555-555555555555",
  source: "issue",
  sourceId: "55555555-5555-4555-8555-555555555555",
  aliases: [],
};
const model: FixesModel = {
  projectId: PROJECT,
  open: [fix, issueFix],
  applied: [],
  stats: fixStats([]),
  failed: [],
  rewritesOn: false,
  overridesAdopted: null,
};

const set: FixEvalSetRow = {
  id: SET,
  projectId: PROJECT,
  fixId: FIX,
  fixKind: "merge",
  title: "Merge two tools",
  change: {},
  source: null,
  targetRuns: 20,
  createdBy: ACTOR,
  evidenceTurnIds: [],
  createdAt: new Date("2026-11-01T00:00:00Z"),
  updatedAt: new Date("2026-11-01T00:00:00Z"),
};

const evalCase: EvalCase = {
  id: CASE,
  turnId: "66666666-6666-4666-8666-666666666666",
  traceId: null,
  origin: "manual" as EvalCase["origin"],
  originRef: null,
  expected: {
    tool: "find_flight",
    maxToolCalls: 3,
    maxSearches: null,
    maxFailedCalls: null,
    avoidTools: [],
    endsWell: true,
  },
  outcome: "Books the flight",
  criteria: "Holds a fare.",
  position: 0,
};

function page(over: Partial<EvalGatePageModel> = {}): EvalGatePageModel {
  const run = {
    id: "run-1",
    status: "completed",
    verdict: "better",
    before: { passed: 10, total: 20, passRate: 0.5, score: 0.5 },
    after: { passed: 18, total: 20, passRate: 0.9, score: 0.9 },
    nCases: 20,
    nSimulated: 20,
    interval: { low: 0.1, high: 0.5 },
    createdAt: "2026-11-01T00:00:00.000Z",
    finishedAt: "2026-11-01T00:05:00.000Z",
    error: null,
    evidence: null,
    breakdown: null,
    methods: null,
    method: "replay",
    judge: null,
    replay: true,
  } as unknown as EvalGatePageModel["history"][number];
  return {
    projectId: PROJECT,
    fixId: FIX,
    fix: { id: FIX, short: fix.short, kindLabel: "Merge", href: "/fixes" },
    source: null,
    method: "replay",
    blocked: null,
    set: {
      id: SET,
      title: "Merge two tools",
      targetRuns: 20,
      change: ["Merge find_flight and hold_fare"],
      unsupportedReason: null,
      method: "replay",
      replayChange: [],
      holdoutRuns: 30,
      evidenceRuns: 0,
    },
    cases: Array.from({ length: 30 }, (_, i) => ({
      ...evalCase,
      id: `case-${i}`,
      criteria: "c".repeat(700),
      originLabel: "Added by you",
      expectedText: "Calls find_flight",
      runHref: "/runs",
      traceHref: null,
      result: null,
      skippedLabel: null,
      role: "holdout",
      methodLabel: null,
      methodNote: null,
      replayPaths: null,
    })),
    badge: { state: "none" },
    latest: run,
    history: Array.from({ length: 8 }, () => run),
    tools: [],
    ...over,
  };
}

interface Tracked {
  name: string;
  properties: Record<string, unknown>;
}

function deps(events: Tracked[], over: Partial<FixEvalSetDeps> = {}): FixEvalSetDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error("This call was not expected.");
  };
  return {
    ...defaultFixEvalSetDeps,
    evalGateEnabled: async () => true,
    loadFixContext: async (projectId, fixId) => (fixId === FIX ? { projectId, fix } : null),
    loadEvalGatePage: async () => page(),
    getEvalSet: async (_projectId, fixId) => (fixId === FIX ? set : null),
    ensureEvalSet: unexpected,
    topUpEvalSet: unexpected,
    addRunToSet: unexpected,
    listCases: async () => [evalCase],
    updateCase: unexpected,
    removeCase: unexpected,
    loadProjectFixes: async () => model,
    dismissCraftProposal: unexpected,
    now: () => new Date("2026-11-05T00:00:00Z"),
    trackServerEvent: (async (
      name: string,
      _context: unknown,
      properties: Record<string, unknown>,
    ) => {
      events.push({ name, properties });
    }) as FixEvalSetDeps["trackServerEvent"],
    ...over,
  };
}

async function run(
  id: string,
  params: Record<string, unknown>,
  events: Tracked[] = [],
  over: Partial<FixEvalSetDeps> = {},
) {
  const d = deps(events, over);
  return dispatchOperation(id, params, {
    registry: buildRegistry([...loopEvalSetReadOperations(d), ...loopEvalSetWriteOperations(d)]),
    auth,
  });
}

function data<T>(result: Awaited<ReturnType<typeof run>>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

function error(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result as unknown as { error: string; reason?: string; message: string };
}

test("get_fix_eval_set reads the fix's eval page as the caller, capping cases and history and cutting long text", async () => {
  const asked: unknown[] = [];
  const result = await run("get_fix_eval_set", { fixId: FIX, limit: 10 }, [], {
    loadEvalGatePage: async (...args) => (
      asked.push([args[0], args[1], args[2]?.id, args[3]]), page()
    ),
  });
  const out = data<{
    evalSet: {
      caseCount: number;
      cases: { caseId: string; criteria: string; role: string; expected: unknown }[];
      history: unknown[];
      latest: { interval: unknown; verdict: string };
      set: { change: string[] };
      href: string;
    };
  }>(result);
  assert.deepEqual(asked, [[PROJECT, FIX, FIX, ACTOR]]);
  assert.equal(out.evalSet.caseCount, 30);
  assert.equal(out.evalSet.cases.length, 10);
  assert.equal(out.evalSet.cases[0]!.criteria.length, 601);
  assert.equal(out.evalSet.cases[0]!.role, "holdout");
  assert.deepEqual(out.evalSet.cases[0]!.expected, evalCase.expected);
  assert.equal(out.evalSet.history.length, 5);
  assert.deepEqual(out.evalSet.latest.interval, { low: 0.1, high: 0.5 });
  assert.equal(
    out.evalSet.href,
    `/project/${PROJECT}/improvement/fixes/${encodeURIComponent(FIX)}/eval`,
  );
  assert.equal((result as DispatchSuccess).truncated, true);
});

test("get_fix_eval_set is not found for a fix with neither an open fix nor a set, and refuses a malformed id", async () => {
  assert.equal(
    error(
      await run("get_fix_eval_set", { fixId: "issue:gone" }, [], {
        loadEvalGatePage: async () => page({ set: null }),
      }),
    ).error,
    "not_found",
  );
  assert.equal(
    error(await run("get_fix_eval_set", { fixId: "not a fix" })).error,
    "invalid_params",
  );
});

test("the eval set tools refuse with eval_gate_off when the gate is off, and change nothing", async () => {
  const events: Tracked[] = [];
  const off = {
    evalGateEnabled: async () => false,
    loadEvalGatePage: async (): Promise<never> => {
      throw new Error("must not read");
    },
  };
  for (const [id, params] of [
    ["get_fix_eval_set", { fixId: FIX }],
    ["change_fix_eval_set", { fixId: FIX, action: "create" }],
  ] as const) {
    const result = error(await run(id, params, events, off));
    assert.deepEqual([result.error, result.reason], ["forbidden", "eval_gate_off"], id);
  }
  assert.equal(events.length, 0);
});

test("change_fix_eval_set create and top_up go through ensureEvalSet and topUpEvalSet as the caller, with the console's events", async () => {
  const events: Tracked[] = [];
  const ensured: unknown[] = [];
  const over: Partial<FixEvalSetDeps> = {
    ensureEvalSet: async (ctx, actor) => (
      ensured.push([ctx.fix.id, actor]), { set, created: ensured.length === 1 }
    ),
    topUpEvalSet: async (s, f) => (s.id === SET && f.id === FIX ? 4 : 0),
  };
  const created = data<{ setId: string; created: boolean }>(
    await run("change_fix_eval_set", { fixId: FIX, action: "create" }, events, over),
  );
  assert.deepEqual([created.setId, created.created], [SET, true]);
  const topped = data<{ added: number; message: string }>(
    await run("change_fix_eval_set", { fixId: FIX, action: "top_up" }, events, over),
  );
  assert.equal(topped.added, 4);
  assert.deepEqual(ensured, [
    [FIX, ACTOR],
    [FIX, ACTOR],
  ]);
  assert.deepEqual(
    events.map((event) => [event.name, event.properties.surface, event.properties.how ?? null]),
    [
      ["fix_eval_set_created", "mcp", null],
      ["fix_eval_case_added", "mcp", "history"],
    ],
  );
  assert.equal(
    error(await run("change_fix_eval_set", { fixId: "craft:gone", action: "create" }, [], over))
      .error,
    "not_found",
  );
});

test("change_fix_eval_set add_run adds by run or trace id, says when it was there already, and refuses an unknown run", async () => {
  const events: Tracked[] = [];
  const over = (
    outcome: Awaited<ReturnType<FixEvalSetDeps["addRunToSet"]>>,
  ): Partial<FixEvalSetDeps> => ({
    ensureEvalSet: async () => ({ set, created: false }),
    addRunToSet: async (s, f, raw) => (
      assert.deepEqual([s.id, f?.id, raw], [SET, FIX, "trace-abc"]), outcome
    ),
  });
  assert.equal(
    data<{ added: number }>(
      await run(
        "change_fix_eval_set",
        { fixId: FIX, action: "add_run", runId: " trace-abc " },
        events,
        over({ ok: true, added: true }),
      ),
    ).added,
    1,
  );
  assert.equal(
    data<{ added: number }>(
      await run(
        "change_fix_eval_set",
        { fixId: FIX, action: "add_run", runId: "trace-abc" },
        events,
        over({ ok: true, added: false }),
      ),
    ).added,
    0,
  );
  assert.equal(
    error(
      await run(
        "change_fix_eval_set",
        { fixId: FIX, action: "add_run", runId: "trace-abc" },
        events,
        over({ ok: false, reason: "not-found" }),
      ),
    ).error,
    "not_found",
  );
  assert.deepEqual(
    events.map((event) => [event.name, event.properties.how]),
    [["fix_eval_case_added", "manual"]],
  );
  assert.equal(
    error(await run("change_fix_eval_set", { fixId: FIX, action: "add_run" })).error,
    "invalid_params",
  );
});

test("change_fix_eval_set update_case changes only the fields given, keeps the rest, and names the checks it turns on", async () => {
  const events: Tracked[] = [];
  const patches: unknown[] = [];
  const out = data<{
    expected: {
      tool: string | null;
      maxToolCalls: number | null;
      maxCostUsd: number | null;
      endsWell: boolean | null;
    };
    criteria: string;
  }>(
    await run(
      "change_fix_eval_set",
      { fixId: FIX, action: "update_case", caseId: CASE, tool: null, maxCostUsd: 0.25 },
      events,
      {
        updateCase: async (setId, caseId, patch) => (patches.push([setId, caseId, patch]), true),
      },
    ),
  );
  assert.equal(out.expected.tool, null, "null clears a field");
  assert.equal(out.expected.maxToolCalls, 3, "a field left out keeps its value");
  assert.equal(out.expected.maxCostUsd, 0.25);
  assert.equal(out.expected.endsWell, true);
  assert.equal(out.criteria, "Holds a fare.");
  assert.equal((patches[0] as unknown[])[0], SET);
  assert.equal(events[0]!.name, "fix_eval_case_updated");
  assert.deepEqual(events[0]!.properties.checks, [
    "max_tool_calls",
    "ends_well",
    "max_cost",
    "criteria",
  ]);
  assert.equal(
    error(
      await run("change_fix_eval_set", {
        fixId: FIX,
        action: "update_case",
        caseId: "77777777-7777-4777-8777-777777777777",
      }),
    ).error,
    "not_found",
  );
  assert.equal(
    error(await run("change_fix_eval_set", { fixId: FIX, action: "update_case" })).error,
    "invalid_params",
  );
});

test("change_fix_eval_set remove_case removes from the fix's set, and an already removed run is not found", async () => {
  const events: Tracked[] = [];
  const removed: unknown[] = [];
  data(
    await run("change_fix_eval_set", { fixId: FIX, action: "remove_case", caseId: CASE }, events, {
      removeCase: async (setId, caseId) => (removed.push([setId, caseId]), true),
    }),
  );
  assert.deepEqual(removed, [[SET, CASE]]);
  assert.deepEqual(
    [events[0]!.name, events[0]!.properties.case_id, events[0]!.properties.surface],
    ["fix_eval_case_removed", CASE, "mcp"],
  );
  assert.equal(
    error(
      await run("change_fix_eval_set", { fixId: FIX, action: "remove_case", caseId: CASE }, [], {
        removeCase: async () => false,
      }),
    ).error,
    "not_found",
  );
  assert.equal(
    error(
      await run("change_fix_eval_set", {
        fixId: "issue:55555555-5555-4555-8555-555555555555",
        action: "remove_case",
        caseId: CASE,
      }),
    ).error,
    "not_found",
  );
});

test("dismiss_fix dismisses a drafted tool change by its proposal id and emits the console's event", async () => {
  const events: Tracked[] = [];
  const calls: unknown[] = [];
  const out = data<{ fixId: string; dismissed: boolean }>(
    await run("dismiss_fix", { fixId: FIX }, events, {
      dismissCraftProposal: async (projectId, id, now) => (
        calls.push([projectId, id, now.toISOString()]), true
      ),
    }),
  );
  assert.deepEqual(calls, [[PROJECT, PROPOSAL, "2026-11-05T00:00:00.000Z"]]);
  assert.deepEqual(out, { fixId: FIX, dismissed: true });
  assert.equal(events[0]!.name, "tool_craft_proposal_dismissed");
  assert.equal(events[0]!.properties.proposal_id, PROPOSAL);
  assert.equal(events[0]!.properties.surface, "mcp");
});

test("dismiss_fix refuses kinds the console cannot dismiss, and a fix already dismissed", async () => {
  const refused = error(await run("dismiss_fix", { fixId: issueFix.id }));
  assert.deepEqual([refused.error, refused.reason], ["conflict", "not_dismissable"]);
  const gone = error(
    await run("dismiss_fix", { fixId: FIX }, [], { dismissCraftProposal: async () => false }),
  );
  assert.deepEqual([gone.error, gone.reason], ["conflict", "already_dismissed"]);
  assert.equal(
    error(await run("dismiss_fix", { fixId: "craft:99999999-9999-4999-8999-999999999999" })).error,
    "not_found",
  );
});
