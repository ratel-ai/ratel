import assert from "node:assert/strict";
import test from "node:test";
import {
  argumentNamedIn,
  classifyError,
  countTurnReliability,
  createReliabilityStats,
  finishReliability,
} from "@/lib/readings/tool-explorer/reliability";
import type { ExplorerEdge, ExplorerSet } from "@/lib/readings/tool-explorer/types";
import {
  gapToolName,
  isReadTool,
  pickComposeCandidates,
  pickEnrichCandidates,
  pickFoldCandidates,
  pickGapCandidates,
  pickParallelCandidates,
  pickPreloadCandidates,
  pickRequireCandidates,
  pickSplitByUseCandidates,
  pickTightenCandidates,
} from "@/lib/synthesis/tool-crafter/candidates";
import {
  draftCompose,
  draftEnrich,
  draftGap,
  draftParallel,
  draftPreload,
  draftRequire,
  draftSplitByUse,
  draftTighten,
} from "@/lib/synthesis/tool-crafter/draft";
import { checkProposal } from "@/lib/synthesis/tool-crafter/schema-check";
import {
  maturityOf,
  orderSuggestions,
  suggestionView,
} from "@/lib/synthesis/tool-crafter/suggestion-model";
import type { SourceTool } from "@/lib/synthesis/tool-crafter/types";
import { type CraftCardModel, cardSummary, evidenceFacts } from "@/lib/synthesis/tool-crafter/view";

const tool = (
  id: string,
  props: Record<string, { type: string; description?: string; enum?: string[] }>,
  required: string[] = [],
): SourceTool => ({
  id,
  name: id,
  description: `${id.replace(/_/g, " ")} for a task.`,
  searchableDescription: id.replace(/_/g, " "),
  inputSchema: { type: "object", properties: props, required },
});
const find_pr = tool("find_pr", { query: { type: "string", description: "what to find" } }, [
  "query",
]);
const link = tool(
  "link_pr_to_task",
  {
    pr_id: { type: "string", description: "the PR" },
    task_id: { type: "string", description: "the task" },
  },
  ["pr_id", "task_id"],
);
const status = tool(
  "update_status",
  { task_id: { type: "string", description: "the task" }, status: { type: "string" } },
  ["task_id", "status"],
);
const notify = tool("notify", { message: { type: "string", description: "text" } }, ["message"]);
const board = tool("get_board_summary", { project: { type: "string", description: "project" } }, [
  "project",
]);
const velocity = tool("compute_velocity", { project: { type: "string", description: "project" } }, [
  "project",
]);
const SOURCES = [find_pr, link, status, notify, board, velocity];
const CATALOG = new Set(SOURCES.map((s) => s.id));

const step = (toolId: string, outcome: "ok" | "error" = "ok", at: number) =>
  ({
    kind: "invoke" as const,
    targetType: "tool",
    targetId: toolId,
    outcome,
    occurredAt: new Date(at),
    tookMs: 100,
  }) as never;
const turn = (steps: unknown[]) => ({ steps }) as never;

const card = (
  body: ReturnType<typeof draftCompose>,
  evidence: CraftCardModel["evidence"],
  sources: SourceTool[],
): CraftCardModel => ({
  id: "p",
  kind: body.kind,
  status: "pending",
  sources,
  crafted: body.crafted,
  hidden: body.hidden,
  rationale: body.rationale,
  details: body.details,
  expectedEffect: body.expectedEffect,
  migrationNotes: body.migrationNotes,
  evidence,
  backtest: null,
  createdAt: new Date(0),
});

test("compose: a stable chain of three or more becomes one tool whose dispatch is the chain in order", () => {
  const workflows = [
    {
      id: "wf1",
      typicalOrder: ["find_pr", "link_pr_to_task", "update_status", "notify"],
      orderStability: 0.92,
      runs: 52,
      medianMs: 2_100,
      medianModelCalls: 5,
      medianCostUsd: 0.02,
    },
    {
      id: "wf2",
      typicalOrder: ["get_board_summary", "compute_velocity"],
      orderStability: 1,
      runs: 40,
      medianMs: 900,
      medianModelCalls: 3,
      medianCostUsd: null,
    },
    {
      id: "wf3",
      typicalOrder: ["find_pr", "notify", "update_status"],
      orderStability: 0.5,
      runs: 80,
      medianMs: null,
      medianModelCalls: null,
      medianCostUsd: null,
    },
  ];
  const picked = pickComposeCandidates(workflows, new Set(), CATALOG);
  assert.deepEqual(
    picked.map((c) => c.evidence.workflowId),
    ["wf1"],
    "two steps is a merge; an unstable order is not a chain",
  );
  assert.deepEqual(
    pickComposeCandidates(workflows, new Set(["notify"]), CATALOG),
    [],
    "a tool another proposal took disqualifies the chain",
  );
  const body = draftCompose({
    tools: [find_pr, link, status, notify],
    evidence: picked[0]!.evidence,
    catalogIds: CATALOG,
  });
  assert.equal(body.kind, "compose_chain");
  assert.equal(body.crafted[0]!.name, "find_pr_to_notify");
  assert.deepEqual(
    body.crafted[0]!.dispatch.map((d) => [d.sourceToolId, d.order]),
    [
      ["find_pr", 0],
      ["link_pr_to_task", 1],
      ["update_status", 2],
      ["notify", 3],
    ],
  );
  assert.deepEqual(Object.keys(body.crafted[0]!.inputSchema.properties ?? {}).sort(), [
    "message",
    "pr_id",
    "query",
    "status",
    "task_id",
  ]);
  assert.match(
    body.expectedEffect,
    /4 calls become one, about 4 fewer model round-trips per run \(52 runs in this window\)/,
  );
  const check = checkProposal([find_pr, link, status, notify], body, CATALOG);
  assert.ok(check.ok, check.ok ? "" : check.problems.join("; "));
  const summary = cardSummary(
    card(body, { kind: "compose_chain", compose: picked[0]!.evidence }, [
      find_pr,
      link,
      status,
      notify,
    ]),
  );
  assert.equal(
    summary.suggestion,
    "Compose find_pr → link_pr_to_task → update_status → notify into one tool.",
  );
  assert.match(
    summary.why[0]!,
    /52 times, in this order 92% of the time, 2.1 s per run and 5 model calls/,
  );
  assert.deepEqual(
    evidenceFacts({ kind: "compose_chain", compose: picked[0]!.evidence }).map((f) => f.label),
    ["steps", "runs", "in this order", "per run", "model calls per run"],
  );
  const view = suggestionView(
    card(body, { kind: "compose_chain", compose: picked[0]!.evidence }, [
      find_pr,
      link,
      status,
      notify,
    ]),
    (id) => id,
  );
  assert.deepEqual(view.figure, { value: "−4", caption: "model calls / run", measured: true });
  assert.deepEqual(
    view.effects.map((c) => c.text),
    ["4 calls → 1", "−4 round-trips"],
  );
  assert.deepEqual(
    [view.unit, view.windowLabel, view.windowEffects.map((c) => c.text)],
    ["per run", "over the window · 52 runs", ["−195 round-trips"]],
    "unpriced project: the window counts round-trips and says nothing in seconds or dollars",
  );
});

test("parallel: a pair always together in no settled order keeps both tools and says they are independent", () => {
  const set: ExplorerSet = {
    scope: "turn",
    subject: "tool",
    key: "compute_velocity|get_board_summary",
    items: ["compute_velocity", "get_board_summary"],
    size: 2,
    support: 36,
    share: 0.3,
    jaccard: 0.97,
    jaccardLow: 0.9,
    pAb: 1,
    pBa: 0.97,
    workflowId: null,
    exampleSessions: [],
  };
  const edge = (a: string, b: string, kind: "next" | "before", n: number): ExplorerEdge => ({
    scope: "turn",
    kind,
    subject: "tool",
    a,
    b,
    n,
    nA: 36,
    p: n / 36,
    pLow: 0,
    pHigh: 1,
    lift: 1,
    reverseN: 0,
    exampleSessions: [],
  });
  const edges = [
    edge("compute_velocity", "get_board_summary", "before", 20),
    edge("get_board_summary", "compute_velocity", "before", 16),
    edge("compute_velocity", "get_board_summary", "next", 18),
    edge("get_board_summary", "compute_velocity", "next", 14),
  ];
  const nodes = [
    {
      id: "compute_velocity",
      subject: "tool" as const,
      calls: 36,
      turnUnits: 36,
      sessionUnits: 30,
      medianMs: 800,
    },
    {
      id: "get_board_summary",
      subject: "tool" as const,
      calls: 36,
      turnUnits: 36,
      sessionUnits: 30,
      medianMs: 500,
    },
  ];
  const picked = pickParallelCandidates([set], edges, new Set(), { nodes });
  assert.equal(picked.length, 1);
  assert.deepEqual(
    pickParallelCandidates(
      [set],
      [
        edge("compute_velocity", "get_board_summary", "before", 34),
        edge("get_board_summary", "compute_velocity", "before", 2),
      ],
      new Set(),
      { nodes },
    ),
    [],
    "one direction only is a dependency, not a parallel pair",
  );
  const body = draftParallel({ a: velocity, b: board, evidence: picked[0]!.evidence });
  assert.deepEqual(
    body.crafted.map((c) => c.name),
    ["compute_velocity", "get_board_summary"],
  );
  assert.match(
    body.crafted[0]!.description,
    /Independent of get_board_summary: when both are needed, call them in the same step/,
  );
  assert.deepEqual(body.crafted[0]!.inputSchema, velocity.inputSchema, "the schema is untouched");
  const check = checkProposal([velocity, board], body, CATALOG);
  assert.ok(check.ok, check.ok ? "" : check.problems.join("; "));
  const broken = {
    ...body,
    crafted: [
      body.crafted[0]!,
      { ...body.crafted[1]!, inputSchema: { type: "object", properties: {} } },
    ],
  };
  const brokenCheck = checkProposal([velocity, board], broken, CATALOG);
  assert.ok(!brokenCheck.ok && brokenCheck.problems.join(";").includes("keeps the schema"));
  const view = suggestionView(
    card(body, { kind: "parallel_pair", parallel: picked[0]!.evidence }, [velocity, board]),
    (id) => id,
  );
  assert.deepEqual(view.figure, { value: "−500 ms", caption: "request time", measured: true });
  assert.equal(view.savingMs, 500 * 36);
});

test("reliability: the explorer counts retries after an error and a tool's errors with and without a predecessor", () => {
  const stats = createReliabilityStats();
  // update_status fails when find_pr was not called first, and the retry succeeds.
  for (let i = 0; i < 12; i += 1)
    countTurnReliability(stats, turn([step("find_pr", "ok", 0), step("update_status", "ok", 1)]));
  const failed = {
    kind: "invoke" as const,
    targetType: "tool",
    targetId: "update_status",
    outcome: "error",
    occurredAt: new Date(0),
    tookMs: 100,
    endTraceEventId: "e",
  } as never;
  const named = new Map([["e", { message: "Invalid status: must be one of todo, done" }]]);
  for (let i = 0; i < 10; i += 1)
    countTurnReliability(stats, turn([failed, step("update_status", "ok", 1)]), named);
  countTurnReliability(stats, turn([failed]), named);
  const out = finishReliability(stats);
  const statusRow = out.tools.find((t) => t.toolId === "update_status")!;
  assert.deepEqual(
    statusRow,
    {
      toolId: "update_status",
      calls: 33,
      errorCalls: 11,
      retriedErrors: 10,
      recoveredRetries: 10,
      retriedByClass: { validation: 10, not_found: 0, server: 0, other: 0 },
      recoveredByClass: { validation: 10, not_found: 0, server: 0, other: 0 },
      recoveredDirect: 10,
      namedRecovered: 10,
      namedArguments: ["status"],
      recoveredVia: [],
    },
    "ten named failures, each retried straight and recovered",
  );
  const pair = out.prerequisites.find((p) => p.a === "find_pr" && p.b === "update_status")!;
  assert.deepEqual(pair, {
    a: "find_pr",
    b: "update_status",
    withA: { calls: 12, errors: 0 },
    withoutA: { calls: 21, errors: 11 },
  });

  const req = pickRequireCandidates(out.prerequisites, new Set());
  assert.deepEqual(
    req.map((r) => [r.a, r.b]),
    [["find_pr", "update_status"]],
  );
  const body = draftRequire({
    a: find_pr,
    b: status,
    evidence: req[0]!.evidence,
    catalogIds: CATALOG,
  });
  assert.equal(body.kind, "require_prerequisite");
  assert.equal(body.crafted[0]!.name, "update_status_with_find");
  assert.deepEqual(
    body.crafted[0]!.inputSchema.required,
    ["task_id", "status"],
    "the main tool's requirements stand; the lookup's input is optional",
  );
  assert.ok(checkProposal([find_pr, status], body, CATALOG).ok);
  assert.match(
    body.rationale,
    /fails 52% of the time when find_pr did not run earlier in the turn \(11 of 21\) and 0% when it did \(0 of 12\)/,
  );
  const view = suggestionView(
    card(body, { kind: "require_prerequisite", require: req[0]!.evidence }, [find_pr, status]),
    (id) => id,
  );
  assert.deepEqual(view.figure, { value: "52% → 0%", caption: "failures", measured: true });

  const tight = pickTightenCandidates(out.tools, SOURCES, new Set());
  assert.deepEqual(
    tight.map((t) => t.toolId),
    ["update_status"],
  );
  assert.deepEqual(
    tight[0]!.evidence.freeTextArgs,
    ["status"],
    "a free-text status reads like an enum",
  );
  assert.deepEqual(tight[0]!.evidence.undocumentedArgs, ["status"]);
  const tb = draftTighten({ tool: status, evidence: tight[0]!.evidence });
  assert.equal(tb.crafted.length, 0);
  assert.match(
    tb.migrationNotes,
    /give `status` an enum of the accepted values; describe `status`/,
  );
  assert.ok(checkProposal([status], tb, CATALOG).ok);
  const tv = suggestionView(
    card(tb, { kind: "tighten_schema", tighten: tight[0]!.evidence }, [status]),
    (id) => id,
  );
  assert.deepEqual(tv.figure, { value: "−10", caption: "failed calls", measured: true });
  assert.deepEqual(
    pickTightenCandidates(out.tools, SOURCES, new Set(["update_status"])),
    [],
    "a taken tool is skipped",
  );
  assert.deepEqual(
    orderSuggestions([tv, view]).map((v) => v.kind),
    ["require_prerequisite", "tighten_schema"],
    "same tier: more failures avoided first",
  );
});

test("per ask: a read that always follows another tool enriches that tool's response; an ask that always opens with a read pre-loads it", () => {
  const closeout = tool("get_daily_closeout_context", {
    date: { type: "string", description: "day" },
  });
  const projects = tool("search_projects", { query: { type: "string", description: "name" } });
  const sources = [...SOURCES, closeout, projects];
  assert.deepEqual(
    [isReadTool(projects), isReadTool(closeout), isReadTool(notify), isReadTool(link)],
    [true, true, false, false],
  );
  const intents = [
    {
      intentId: "i1",
      text: "close out the day",
      units: 20,
      tools: [
        { toolId: "get_daily_closeout_context", n: 20 },
        { toolId: "search_projects", n: 19 },
      ],
      edges: [{ a: "get_daily_closeout_context", b: "search_projects", n: 19, na: 20 }],
      firsts: [{ t: "get_daily_closeout_context", n: 19 }],
      calls: 40,
    },
    {
      intentId: "i2",
      text: "create a task",
      units: 12,
      tools: [
        { toolId: "search_projects", n: 12 },
        { toolId: "update_status", n: 11 },
      ],
      edges: [{ a: "search_projects", b: "update_status", n: 11, na: 12 }],
      firsts: [{ t: "search_projects", n: 11 }],
      calls: 24,
    },
    {
      intentId: "i3",
      text: "tiny",
      units: 2,
      tools: [
        { toolId: "find_pr", n: 2 },
        { toolId: "get_board_summary", n: 2 },
      ],
      edges: [{ a: "find_pr", b: "get_board_summary", n: 2, na: 2 }],
      firsts: [{ t: "find_pr", n: 2 }],
      calls: 4,
    },
  ];
  const nodes = [
    { id: "search_projects", turnUnits: 60, medianMs: 300 },
    { id: "get_daily_closeout_context", turnUnits: 20, medianMs: 900 },
  ];
  const enrich = pickEnrichCandidates(intents, sources, nodes, new Set());
  assert.deepEqual(
    enrich.map((c) => [c.a, c.b]),
    [["get_daily_closeout_context", "search_projects"]],
    "update_status writes, so i2's hop is not an enrichment; i3 has two calls, under the floor",
  );
  assert.deepEqual(enrich[0]!.evidence, {
    intentId: "i1",
    intentText: "close out the day",
    units: 20,
    a: "get_daily_closeout_context",
    b: "search_projects",
    n: 19,
    na: 20,
    bMedianMs: 300,
    bUnitsOutside: 41,
  });
  const body = draftEnrich({ a: closeout, b: projects, evidence: enrich[0]!.evidence });
  assert.equal(body.crafted.length, 0);
  assert.match(
    body.rationale,
    /search_projects came right after get_daily_closeout_context in 19 of 20 calls \(95%\)/,
  );
  assert.ok(checkProposal([closeout, projects], body, new Set(sources.map((s) => s.id))).ok);
  const view = suggestionView(
    card(body, { kind: "enrich_response", enrich: enrich[0]!.evidence }, [closeout, projects]),
    (id) => id,
  );
  assert.equal(view.verb, "Enrich");
  assert.equal(
    view.headline,
    "Return what search_projects fetches in get_daily_closeout_context's response.",
  );
  assert.deepEqual(view.figure, { value: "−300 ms", caption: "per turn", measured: true });
  assert.deepEqual(
    view.asks,
    [{ intentId: "i1", text: "close out the day", units: 20 }],
    "the ask is the proposal's own",
  );
  assert.equal(view.savingMs, 300 * 19);
  assert.equal(view.maturity, "solid");

  const pre = pickPreloadCandidates(
    intents,
    sources,
    nodes,
    new Set(["get_daily_closeout_context"]),
  );
  assert.deepEqual(
    pre.map((c) => c.toolId),
    ["search_projects"],
    "the taken tool is skipped; i2 opens with search_projects 11 of 12",
  );
  const pb = draftPreload({ tool: projects, evidence: pre[0]!.evidence });
  assert.match(pb.rationale, /11 of 12 turns of "create a task" \(92%\) open with search_projects/);
  const pv = suggestionView(
    card(pb, { kind: "preload_context", preload: pre[0]!.evidence }, [projects]),
    (id) => id,
  );
  assert.equal(pv.verb, "Pre-load");
  assert.deepEqual(
    pv.effects.map((c) => c.text),
    ["−1 call", "−1 round-trip", "−300 ms waiting"],
  );
  assert.deepEqual(
    pv.windowEffects.map((c) => c.text),
    ["−11 round-trips", "−3.3 s waiting"],
  );
  assert.deepEqual(
    [maturityOf(3), maturityOf(10), maturityOf(30)],
    ["early", "solid", "established"],
  );
  assert.deepEqual(
    orderSuggestions([pv, view]).map((v) => v.kind),
    ["enrich_response", "preload_context"],
    "the bigger saving over the window first",
  );
});

test("per ask: a tool with different sure followers under different asks is used two ways; an ask with no path and many calls is a gap", () => {
  const filter = tool("filter_tasks", { status: { type: "string", description: "status" } });
  const projects = tool("search_projects", { query: { type: "string", description: "name" } });
  const assign = tool("assign_task", { task_id: { type: "string", description: "task" } }, [
    "task_id",
  ]);
  const sources = [...SOURCES, filter, projects, assign];
  const catalog = new Set(sources.map((s) => s.id));
  const two = [
    {
      intentId: "a",
      text: "search tasks by status",
      units: 40,
      calls: 90,
      tools: [
        { toolId: "filter_tasks", n: 40 },
        { toolId: "search_projects", n: 38 },
      ],
      edges: [{ a: "filter_tasks", b: "search_projects", n: 14, na: 14 }],
      firsts: [],
    },
    {
      intentId: "b",
      text: "hand a task over",
      units: 30,
      calls: 70,
      tools: [
        { toolId: "filter_tasks", n: 30 },
        { toolId: "assign_task", n: 29 },
      ],
      edges: [{ a: "filter_tasks", b: "assign_task", n: 12, na: 13 }],
      firsts: [],
    },
    {
      intentId: "c",
      text: "same way",
      units: 20,
      calls: 40,
      tools: [{ toolId: "filter_tasks", n: 20 }],
      edges: [{ a: "filter_tasks", b: "search_projects", n: 6, na: 6 }],
      firsts: [],
    },
  ];
  const picked = pickSplitByUseCandidates(two, sources, new Set());
  assert.deepEqual(
    picked.map((c) => c.toolId),
    ["filter_tasks"],
  );
  assert.deepEqual(
    picked[0]!.evidence.uses.map((u) => [u.intentId, u.follower]),
    [
      ["a", "search_projects"],
      ["b", "assign_task"],
    ],
    "one use per follower, the biggest ask for each; ask c repeats a's way",
  );
  assert.deepEqual(
    pickSplitByUseCandidates(two.slice(0, 1), sources, new Set()),
    [],
    "one way is not two",
  );
  const body = draftSplitByUse({ tool: filter, evidence: picked[0]!.evidence });
  assert.equal(body.crafted.length, 0);
  assert.deepEqual(body.sourceToolIds, ["filter_tasks", "search_projects", "assign_task"]);
  assert.ok(checkProposal([filter, projects, assign], body, catalog).ok);
  const view = suggestionView(
    card(body, { kind: "split_by_use", splitByUse: picked[0]!.evidence }, [
      filter,
      projects,
      assign,
    ]),
    (id) => id,
  );
  assert.equal(view.verb, "Split by use");
  assert.equal(
    view.headline,
    "filter_tasks is used 2 ways: split it, or return what search_projects and assign_task fetch.",
  );
  assert.deepEqual(view.figure, { value: "2 ways", caption: "one tool", measured: true });
  assert.deepEqual(
    view.asks.map((a) => a.intentId),
    ["a", "b"],
  );
  assert.deepEqual([view.unit, view.windowLabel], ["per hop", "over the window · 26 hops"]);

  const sprawl = {
    intentId: "g",
    text: "summarise the sprint for my team",
    units: 60,
    calls: 360,
    tools: Array.from({ length: 11 }, (_, i) => ({
      toolId: i < 3 ? ["find_pr", "notify", "update_status"][i]! : `t${i}`,
      n: 40 - i,
    })),
    edges: [{ a: "find_pr", b: "notify", n: 20, na: 50 }],
    firsts: [],
  };
  const gaps = pickGapCandidates([sprawl, ...two], 2.4, catalog, new Set());
  assert.deepEqual(
    gaps.map((g) => g.intentId),
    ["g"],
    "the two-way asks have sure hops; the sprawl has none, 11 tools and 6 calls per turn against 2.4",
  );
  assert.equal(gaps[0]!.evidence.suggestedName, "summarise_sprint_team");
  assert.equal(gapToolName("get the task", new Set(["task"])), "task_2");
  assert.deepEqual(
    pickGapCandidates([sprawl], null, catalog, new Set()),
    [],
    "no project norm, no gap",
  );
  const gb = draftGap({ tools: [find_pr, notify, status], evidence: gaps[0]!.evidence });
  assert.equal(gb.kind, "fill_gap");
  assert.match(gb.rationale, /60 turns reached 11 different tools, 6.0 calls per turn against 2.4/);
  assert.ok(checkProposal([find_pr, notify, status], gb, catalog).ok);
  const gv = suggestionView(
    card(gb, { kind: "fill_gap", gap: gaps[0]!.evidence }, [find_pr, notify, status]),
    (id) => id,
    [],
    { price: { ms: 1000, usd: 0.02, inputTokens: 4000, outputTokens: 100, modelCalls: 500 } },
  );
  assert.equal(gv.verb, "New tool");
  assert.deepEqual(gv.figure, { value: "6.0 → 1", caption: "calls / turn", measured: true });
  assert.deepEqual(
    gv.effects.map((c) => c.text),
    ["6.0 calls → 1", "−5.0 round-trips"],
  );
  assert.deepEqual(
    gv.windowEffects.map((c) => c.text),
    ["−300 round-trips (60%)", "−5 min waiting", "−1.2M tokens", "−$6.00"],
    "60 turns × 5 round-trips, priced",
  );
});

test("reliability reads the error messages and the recovery path: a named straight retry is a tighten, a recovery through a lookup is a prerequisite, the rest is reported or dropped", () => {
  assert.equal(classifyError("validation_failed"), "validation");
  assert.equal(
    classifyError(
      "Invalid statusKey or statusId — status not available in the destination project",
    ),
    "validation",
  );
  assert.equal(classifyError("Description must be 10000 characters or less"), "validation");
  assert.equal(classifyError("Task not found"), "not_found");
  assert.equal(classifyError("Internal server error"), "server");
  assert.equal(classifyError("operation_failed"), "other");
  assert.equal(classifyError(null), "other");
  assert.equal(
    argumentNamedIn("Invalid statusKey or statusId — status not available"),
    "statusKey",
  );
  assert.equal(argumentNamedIn("Description must be 10000 characters or less"), "Description");
  assert.equal(argumentNamedIn("validation_failed"), null);
  assert.equal(argumentNamedIn("Task not found"), null);

  const info = (message: string | null) => ({ message });
  const errorStep = (toolId: string, endId: string, at: number) =>
    ({
      kind: "invoke" as const,
      targetType: "tool",
      targetId: toolId,
      outcome: "error",
      occurredAt: new Date(at),
      tookMs: 100,
      endTraceEventId: endId,
    }) as never;
  const errors = new Map([
    ["named", info("Invalid statusKey or statusId")],
    ["named2", info("Description must be 10000 characters or less")],
    ["bare", info("validation_failed")],
    ["missing", info("Task not found")],
    ["server", info("Internal server error")],
  ]);
  const stats = createReliabilityStats();
  // Three named failures, retried straight, all recovered.
  for (const id of ["named", "named", "named2"])
    countTurnReliability(
      stats,
      turn([errorStep("create_task", id, 0), step("create_task", "ok", 1)]),
      errors,
    );
  // Two bare codes retried straight and recovered; one bare code whose retry failed again.
  for (let i = 0; i < 2; i += 1)
    countTurnReliability(
      stats,
      turn([errorStep("create_task", "bare", 0), step("create_task", "ok", 1)]),
      errors,
    );
  countTurnReliability(
    stats,
    turn([errorStep("create_task", "bare", 0), step("create_task", "error", 1)]),
    errors,
  );
  // Four bare codes that recovered only after a lookup in between (two of them after two failures in a row).
  for (let i = 0; i < 2; i += 1)
    countTurnReliability(
      stats,
      turn([
        errorStep("create_task", "bare", 0),
        step("list_task_status_sets", "ok", 1),
        step("create_task", "ok", 2),
      ]),
      errors,
    );
  for (let i = 0; i < 2; i += 1)
    countTurnReliability(
      stats,
      turn([
        errorStep("create_task", "bare", 0),
        errorStep("create_task", "bare", 1),
        step("list_task_status_sets", "ok", 2),
        step("create_task", "ok", 3),
      ]),
      errors,
    );
  // One of each kind of error that is not about the schema, both recovered.
  for (const id of ["missing", "server"])
    countTurnReliability(
      stats,
      turn([errorStep("create_task", id, 0), step("create_task", "ok", 1)]),
      errors,
    );
  const row = finishReliability(stats).tools.find((t) => t.toolId === "create_task")!;
  assert.equal(row.retriedErrors, 3 + 3 + 6 + 2);
  assert.equal(
    row.recoveredRetries,
    3 + 2 + 4 + 2,
    "a failure whose next call also failed did not recover; in a two-failure run only the second recovers",
  );
  assert.deepEqual(
    row.retriedByClass,
    { validation: 12, not_found: 1, server: 1, other: 0 },
    "a bare validation_failed is validation class, naming nothing",
  );
  assert.equal(row.recoveredDirect, 5, "three named and two bare, retried straight");
  assert.equal(row.namedRecovered, 3);
  assert.deepEqual(row.recoveredVia, [{ tool: "list_task_status_sets", n: 4 }]);
  assert.deepEqual(row.namedArguments, ["statusKey", "Description"], "commonest first");

  const create: SourceTool = {
    id: "create_task",
    name: "create_task",
    description: "Create a task.",
    searchableDescription: null,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title" },
        statusKey: { type: "string" },
      },
      required: ["title"],
    },
  };
  const statuses: SourceTool = {
    id: "list_task_status_sets",
    name: "list_task_status_sets",
    description: "Discover the allowed statuses of a project.",
    searchableDescription: null,
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "The project" } },
    },
  };
  const [cand] = pickTightenCandidates([row], [create, statuses], new Set());
  assert.ok(cand, "three named straight recoveries: a tighten");
  assert.deepEqual(
    [
      cand!.evidence.namedRecovered,
      cand!.evidence.directRecovered,
      cand!.evidence.viaLookup,
      cand!.evidence.excludedRetried,
      cand!.evidence.namedArguments,
    ],
    [3, 5, [{ tool: "list_task_status_sets", n: 4 }], 2, ["statusKey", "Description"]],
  );
  const body = draftTighten({ tool: create, evidence: cand!.evidence });
  assert.match(
    body.rationale,
    /3 failures named the argument and the agent's straight retry then succeeded.*; 2 more recovered the same way after a bare error code.*; 4 recovered only after a lookup, which is a prerequisite.*; 2 retried not-found or server errors are not counted/,
  );
  assert.match(
    body.migrationNotes,
    /start with `statusKey`, `Description`: the validation errors named them; compare create_task's validator with its published input schema/,
  );
  assert.match(body.expectedEffect, /^Up to 3 failed first calls avoided/);
  const view = suggestionView(
    card(body as never, { kind: "tighten_schema", tighten: cand!.evidence }, [create]),
    (id) => id,
  );
  assert.deepEqual(
    view.figure,
    { value: "−3", caption: "failed calls", measured: true },
    "only the named straight recoveries are claimed",
  );
  assert.deepEqual(view.namedArguments, ["statusKey", "Description"]);

  // The lookup in the recovery path is a prerequisite, drafted from the path alone (no rate row needed).
  const req = pickRequireCandidates(
    [],
    new Set(),
    {},
    { tools: [row], sources: [create, statuses] },
  );
  assert.deepEqual(
    req.map((r) => [r.a, r.b]),
    [["list_task_status_sets", "create_task"]],
  );
  assert.deepEqual(req[0]!.evidence.recovery, { retried: 14, recovered: 11, via: 4 });
  const reqBody = draftRequire({
    a: statuses,
    b: create,
    evidence: req[0]!.evidence,
    catalogIds: new Set(["create_task", "list_task_status_sets"]),
  });
  assert.match(
    reqBody.rationale,
    /4 of the 11 retries that worked came only after the agent called list_task_status_sets in between/,
  );
  assert.match(reqBody.expectedEffect, /^About 4 fewer failed calls/);
  const reqView = suggestionView(
    card(reqBody as never, { kind: "require_prerequisite", require: req[0]!.evidence }, [
      statuses,
      create,
    ]),
    (id) => id,
  );
  assert.deepEqual(reqView.figure, { value: "−4", caption: "failed calls", measured: true });
  assert.deepEqual(
    pickRequireCandidates(
      [],
      new Set(),
      {},
      {
        tools: [row],
        sources: [
          create,
          { ...statuses, id: "update_task", name: "update_task", description: "Update a task." },
        ],
      },
    ),
    [],
    "a write tool in between is not a lookup",
  );

  // Bare codes alone: reported on the explorer run, but no tighten is claimed.
  const bare = createReliabilityStats();
  for (let i = 0; i < 6; i += 1)
    countTurnReliability(
      bare,
      turn([errorStep("update_task", "bare", 0), step("update_task", "ok", 1)]),
      errors,
    );
  assert.deepEqual(
    pickTightenCandidates(
      finishReliability(bare).tools,
      [{ ...create, id: "update_task", name: "update_task" }],
      new Set(),
    ),
    [],
    "an error that names nothing supports no schema fix",
  );
  // Recoveries after not found: nothing either.
  const notFound = createReliabilityStats();
  for (let i = 0; i < 6; i += 1)
    countTurnReliability(
      notFound,
      turn([errorStep("update_task", "missing", 0), step("update_task", "ok", 1)]),
      errors,
    );
  assert.deepEqual(
    pickTightenCandidates(
      finishReliability(notFound).tools,
      [{ ...create, id: "update_task", name: "update_task" }],
      new Set(),
    ),
    [],
  );
});

const scoped = (
  scope: "turn" | "session",
  a: string,
  b: string,
  kind: "next" | "before",
  n: number,
  nA = 36,
): ExplorerEdge => ({
  scope,
  kind,
  subject: "tool",
  a,
  b,
  n,
  nA,
  p: n / nA,
  pLow: 0,
  pHigh: 1,
  lift: 1,
  reverseN: 0,
  exampleSessions: [],
});

test("a session-scope pair is judged on session-scope edges, even with the turn edges listed first", () => {
  // The crafter reads turn edges first; here they tell another story than the session's.
  const parallel: ExplorerSet = {
    scope: "session",
    subject: "tool",
    key: "compute_velocity|get_board_summary",
    items: ["compute_velocity", "get_board_summary"],
    size: 2,
    support: 36,
    share: 0.3,
    jaccard: 0.97,
    jaccardLow: 0.9,
    pAb: 1,
    pBa: 0.97,
    workflowId: null,
    exampleSessions: [],
  };
  const turnOneWay = [
    scoped("turn", "compute_velocity", "get_board_summary", "before", 34),
    scoped("turn", "get_board_summary", "compute_velocity", "before", 2),
    scoped("turn", "compute_velocity", "get_board_summary", "next", 30),
  ];
  const sessionBothWays = [
    scoped("session", "compute_velocity", "get_board_summary", "before", 20),
    scoped("session", "get_board_summary", "compute_velocity", "before", 16),
    scoped("session", "compute_velocity", "get_board_summary", "next", 18),
    scoped("session", "get_board_summary", "compute_velocity", "next", 14),
  ];
  const picked = pickParallelCandidates([parallel], [...turnOneWay, ...sessionBothWays], new Set());
  assert.equal(picked.length, 1, "the session runs both ways around");
  assert.deepEqual(
    [
      picked[0]!.evidence.orderAb,
      picked[0]!.evidence.orderBa,
      picked[0]!.evidence.nextAb,
      picked[0]!.evidence.nextBa,
    ],
    [20, 16, 18, 14],
    "the counts quoted are the session's",
  );

  const fold: ExplorerSet = {
    scope: "session",
    subject: "tool",
    key: "find_pr|link_pr_to_task",
    items: ["find_pr", "link_pr_to_task"],
    size: 2,
    support: 20,
    share: 0.2,
    jaccard: 0.5,
    jaccardLow: 0.4,
    pAb: 0.97,
    pBa: 0.5,
    workflowId: null,
    exampleSessions: [],
  };
  const turnLoose = [
    scoped("turn", "find_pr", "link_pr_to_task", "before", 1, 20),
    scoped("turn", "link_pr_to_task", "find_pr", "before", 4, 20),
    scoped("turn", "find_pr", "link_pr_to_task", "next", 1, 20),
  ];
  const sessionTight = [
    scoped("session", "find_pr", "link_pr_to_task", "before", 18, 20),
    scoped("session", "link_pr_to_task", "find_pr", "before", 1, 20),
    scoped("session", "find_pr", "link_pr_to_task", "next", 16, 20),
  ];
  const folds = pickFoldCandidates([fold], [...turnLoose, ...sessionTight], new Set());
  assert.deepEqual(
    folds.map((f) => [f.a, f.b]),
    [["find_pr", "link_pr_to_task"]],
    "the lookup runs first in the session",
  );
  assert.deepEqual([folds[0]!.evidence.orderAb, folds[0]!.evidence.orderBa], [18, 1]);
  assert.deepEqual(
    pickFoldCandidates([fold], turnLoose, new Set()),
    [],
    "with only turn edges there is no session evidence",
  );
});

test("fill_gap and split_by_use propose a tool once per run", () => {
  const filter = tool("filter_tasks", { status: { type: "string", description: "status" } });
  const projects = tool("search_projects", { query: { type: "string", description: "name" } });
  const assign = tool("assign_task", { task_id: { type: "string", description: "task" } }, [
    "task_id",
  ]);
  const sources = [...SOURCES, filter, projects, assign];
  const catalog = new Set(sources.map((s) => s.id));
  const asks = [
    {
      intentId: "a",
      text: "search tasks by status",
      units: 40,
      calls: 90,
      tools: [{ toolId: "filter_tasks", n: 40 }],
      edges: [
        { a: "filter_tasks", b: "search_projects", n: 14, na: 14 },
        { a: "search_projects", b: "assign_task", n: 14, na: 14 },
      ],
      firsts: [],
    },
    {
      intentId: "b",
      text: "hand a task over",
      units: 30,
      calls: 70,
      tools: [{ toolId: "filter_tasks", n: 30 }],
      edges: [
        { a: "filter_tasks", b: "assign_task", n: 12, na: 13 },
        { a: "search_projects", b: "notify", n: 12, na: 12 },
      ],
      firsts: [],
    },
  ];
  const splits = pickSplitByUseCandidates(asks, sources, new Set());
  assert.deepEqual(
    splits.map((c) => c.toolId),
    ["filter_tasks"],
    "search_projects is a follower in filter_tasks' split, so it is not split again",
  );

  const sprawl = (intentId: string, text: string) => ({
    intentId,
    text,
    units: 60,
    calls: 360,
    tools: Array.from({ length: 11 }, (_, i) => ({
      toolId: i < 3 ? ["find_pr", "notify", "update_status"][i]! : `t${i}`,
      n: 40 - i,
    })),
    edges: [],
    firsts: [],
  });
  const gaps = pickGapCandidates(
    [sprawl("g", "summarise the sprint"), sprawl("h", "sum up the sprint")],
    2.4,
    catalog,
    new Set(),
  );
  assert.deepEqual(
    gaps.map((g) => g.intentId),
    ["g"],
    "two asks over the same tools make one new tool",
  );
});
