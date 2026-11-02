import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExplorerEdge, ExplorerSet } from "@/lib/readings/tool-explorer/types";
import type { Candidate } from "@/lib/synthesis/match-quality/types";
import {
  pickMergeCandidates,
  pickRewriteCandidates,
} from "@/lib/synthesis/tool-crafter/candidates";
import {
  type CraftRunReads,
  type ExplorerReading,
  runToolCraft,
} from "@/lib/synthesis/tool-crafter/pipeline";
import type { NewProposal } from "@/lib/synthesis/tool-crafter/queries";
import { changeOf, gainOf, suggestionView } from "@/lib/synthesis/tool-crafter/suggestion-model";
import type { PairTiming, SourceTool } from "@/lib/synthesis/tool-crafter/types";
import type { CraftCardModel } from "@/lib/synthesis/tool-crafter/view";

const PROJECT = "11111111-1111-4111-8111-111111111111";

const pair = (
  a: string,
  b: string,
  support: number,
  jaccardLow: number,
  scope: "turn" | "session" = "turn",
): ExplorerSet => ({
  scope,
  subject: "tool",
  key: [a, b].sort().join("|"),
  items: [a, b].sort(),
  size: 2,
  support,
  share: 0.3,
  jaccard: jaccardLow + 0.05,
  jaccardLow,
  pAb: 1,
  pBa: 0.95,
  workflowId: null,
  exampleSessions: ["s1", "s2"],
});
const next = (
  a: string,
  b: string,
  n: number,
  nA: number,
  scope: "turn" | "session" = "turn",
): ExplorerEdge => ({
  scope,
  kind: "next",
  subject: "tool",
  a,
  b,
  n,
  nA,
  p: n / nA,
  pLow: 0,
  pHigh: 1,
  lift: 3,
  reverseN: 0,
  exampleSessions: [],
});
const before = (a: string, b: string, n: number): ExplorerEdge => ({
  ...next(a, b, n, n),
  kind: "before",
});

const tool = (id: string, description: string, required: string[] = []): SourceTool => ({
  id,
  name: id,
  description,
  searchableDescription: null,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(required.map((r) => [r, { type: "string" }])),
    required,
  },
});
const SOURCES = [
  tool("find_task", "Find a task by title.", ["query"]),
  tool("assign_task", "Assign a task.", ["taskId", "assignee"]),
  tool("list_projects", "List projects."),
];

const deficit = (entryId: string, misses: number, queries: string[]): Candidate => ({
  entryId,
  name: entryId,
  misses,
  buried: 0,
  targeted: misses + 2,
  distractions: 0,
  loss: misses,
  failures: queries.map((query) => ({
    query,
    ourRank: null,
    ourTop: "search_tasks",
    baselineTop: entryId,
    targetSource: "observed" as never,
  })),
});

test("pickMergeCandidates keeps always-together pairs with enough support, oriented by who runs first, one proposal per tool", () => {
  const sets = [
    pair("find_task", "assign_task", 40, 0.93),
    pair("find_task", "list_projects", 50, 0.95),
    pair("a", "b", 5, 0.99),
    pair("c", "d", 40, 0.5),
  ];
  const edges = [
    next("find_task", "assign_task", 36, 40),
    before("find_task", "assign_task", 38),
    before("assign_task", "find_task", 2),
  ];
  const picked = pickMergeCandidates(sets, edges);
  assert.deepEqual(
    picked.map((m) => [m.a, m.b]),
    [["find_task", "list_projects"]],
    "the stronger pair takes find_task; the rest are below support or the bound",
  );
  const only = pickMergeCandidates([sets[0]!], edges);
  assert.equal(only[0]!.a, "find_task");
  assert.deepEqual(
    [only[0]!.evidence.nextP, only[0]!.evidence.orderAb, only[0]!.evidence.orderBa],
    [0.9, 38, 2],
  );
  // The set's pAb belongs to its sorted first item (assign_task); after orientation a is find_task.
  assert.equal(only[0]!.evidence.unitsA, 42, "find_task ran in 42 units");
  assert.equal(only[0]!.evidence.unitsB, 40, "assign_task in 40");
});

test("pickRewriteCandidates needs enough misses, skips tools a merge took, and keeps distinct phrasings", () => {
  const picked = pickRewriteCandidates(
    [
      deficit("find_task", 5, ["where is the ticket", "where is the ticket", "which ticket"]),
      deficit("list_projects", 1, ["x"]),
      deficit("assign_task", 4, ["hand it over"]),
    ],
    new Set(["assign_task"]),
  );
  assert.deepEqual(
    picked.map((r) => r.toolId),
    ["find_task"],
  );
  assert.deepEqual(picked[0]!.evidence.missedQueries, ["where is the ticket", "which ticket"]);
  assert.deepEqual(picked[0]!.evidence.distractors, ["search_tasks"]);
});

function reads(
  over: Partial<ExplorerReading & { deficits: Candidate[]; sources: SourceTool[] }> = {},
): CraftRunReads {
  return {
    loadExplorer: async () => ({
      runId: over.runId === undefined ? "run-1" : over.runId,
      windowDays: over.windowDays ?? 30,
      sets: over.sets ?? [],
      pairs: over.pairs ?? over.sets ?? [],
      edges: over.edges ?? [],
      nodes: over.nodes ?? [],
    }),
    loadSources: async () => over.sources ?? SOURCES,
    loadDeficits: async () => over.deficits ?? [],
  };
}

test("runToolCraft drafts a merge and a rewrite by rules, records every nomination", async () => {
  const result = await runToolCraft(
    PROJECT,
    reads({
      sets: [pair("find_task", "assign_task", 40, 0.93), pair("ghost", "assign_task", 40, 0.95)],
      edges: [next("find_task", "assign_task", 36, 40), before("find_task", "assign_task", 38)],
      deficits: [deficit("list_projects", 4, ["show me every workspace", "all the workspaces"])],
    }),
  );
  assert.equal(result.declinedReason, null);
  assert.deepEqual(
    result.proposals.map((p) => [p.body.kind, p.body.sourceToolIds]),
    [
      ["merge_tools", ["find_task", "assign_task"]],
      ["rewrite_tool", ["list_projects"]],
    ],
  );
  assert.deepEqual(result.candidates, [
    {
      kind: "merge_tools",
      tools: ["assign_task", "ghost"],
      outcome: "dropped",
      reason: "source tool not in the runtime catalog",
    },
    { kind: "merge_tools", tools: ["find_task", "assign_task"], outcome: "proposed" },
    { kind: "rewrite_tool", tools: ["list_projects"], outcome: "proposed" },
  ]);
  assert.equal(result.proposals[0]!.evidence.kind, "merge_tools");
});

test("runToolCraft records a nomination the per-run cap dropped", async () => {
  const result = await runToolCraft(
    PROJECT,
    reads({
      sets: [pair("find_task", "assign_task", 40, 0.93)],
      edges: [next("find_task", "assign_task", 36, 40), before("find_task", "assign_task", 38)],
      deficits: [deficit("list_projects", 4, ["show me every workspace", "all the workspaces"])],
    }),
    { maxProposals: 1 },
  );
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.candidates, [
    { kind: "merge_tools", tools: ["find_task", "assign_task"], outcome: "proposed" },
    {
      kind: "rewrite_tool",
      tools: ["list_projects"],
      outcome: "dropped",
      reason: "more than 1 proposals this run",
    },
  ]);
});

test("runToolCraft keeps at most maxPerKind proposals of one kind and audits the rest", async () => {
  const sources = [
    tool("a", "A.", ["x"]),
    tool("b", "B.", ["y"]),
    tool("c", "C.", ["x"]),
    tool("d", "D.", ["y"]),
    tool("e", "E.", ["x"]),
    tool("f", "F.", ["y"]),
  ];
  const result = await runToolCraft(
    PROJECT,
    reads({
      sources,
      sets: [pair("a", "b", 40, 0.93), pair("c", "d", 39, 0.93), pair("e", "f", 38, 0.93)],
      edges: [
        next("a", "b", 36, 40),
        before("a", "b", 38),
        next("c", "d", 36, 39),
        before("c", "d", 37),
        next("e", "f", 36, 38),
        before("e", "f", 36),
      ],
    }),
    { maxPerKind: 2 },
  );
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(
    result.candidates.map((c) => [c.kind, c.outcome, c.reason ?? null]),
    [
      ["merge_tools", "proposed", null],
      ["merge_tools", "proposed", null],
      ["merge_tools", "dropped", "more than 2 of this kind this run"],
    ],
  );
});

test("runToolCraft proposes a tool once per run, even when a picker nominates it twice", async () => {
  // The rewrite picker reads only the tools taken before it ran; two rows for one tool would both pass it.
  const result = await runToolCraft(
    PROJECT,
    reads({
      deficits: [
        deficit("list_projects", 4, ["show me every workspace"]),
        deficit("list_projects", 3, ["all the workspaces"]),
      ],
    }),
  );
  assert.deepEqual(
    result.proposals.map((p) => p.body.sourceToolIds),
    [["list_projects"]],
  );
  assert.deepEqual(result.candidates, [
    { kind: "rewrite_tool", tools: ["list_projects"], outcome: "proposed" },
    {
      kind: "rewrite_tool",
      tools: ["list_projects"],
      outcome: "dropped",
      reason: "already in a proposal this run: list_projects",
    },
  ]);
});

test("runToolCraft explains an empty run", async () => {
  const none = await runToolCraft(PROJECT, reads({ runId: null }));
  assert.equal(none.proposals.length, 0);
  assert.match(none.declinedReason!, /nothing to read yet/);
  const weak = await runToolCraft(
    PROJECT,
    reads({ sets: [pair("find_task", "assign_task", 5, 0.3)] }),
  );
  assert.match(weak.declinedReason!, /no pair is always together/);
});

/** A drafted proposal as the page reads it back. */
const cardOf = (draft: NewProposal): CraftCardModel => ({
  id: "p",
  kind: draft.body.kind,
  status: "pending",
  sources: draft.sources,
  crafted: draft.body.crafted,
  hidden: draft.body.hidden,
  rationale: draft.body.rationale,
  details: draft.body.details,
  expectedEffect: draft.body.expectedEffect,
  migrationNotes: draft.body.migrationNotes,
  evidence: draft.evidence,
  backtest: null,
  createdAt: new Date(0),
});

const TIMING: PairTiming = {
  aCalls: 40,
  bCalls: 40,
  aMedianMs: 200,
  bMedianMs: 300,
  aTotalMs: 8000,
  bTotalMs: 12000,
  handoffPairs: 30,
  handoffMsTotal: 30_000,
  handoffMsMedian: 1000,
  searchesBetween: 0,
};

test("a pair that runs both ways around is drafted as a parallel pair, not a merge", async () => {
  const result = await runToolCraft(
    PROJECT,
    reads({
      sets: [pair("find_task", "assign_task", 40, 0.93)],
      edges: [
        next("find_task", "assign_task", 20, 40),
        next("assign_task", "find_task", 20, 40),
        before("find_task", "assign_task", 20),
        before("assign_task", "find_task", 20),
      ],
    }),
  );
  assert.deepEqual(
    result.proposals.map((p) => p.body.kind),
    ["parallel_pair"],
  );
  const view = suggestionView(cardOf(result.proposals[0]!), (id) => id);
  assert.doesNotMatch(view.effects.map((c) => c.text).join(" "), /2 calls → 1/);
});

test("a mode-switch merge claims no saved call, round-trip or wait, and says it consolidates the catalog", async () => {
  // Leans one way (75 / 25), so it is no parallel pair, but nextP 0.4 is not a sequence either.
  const result = await runToolCraft(
    PROJECT,
    reads({
      sets: [pair("find_task", "assign_task", 40, 0.93)],
      edges: [
        next("find_task", "assign_task", 16, 40),
        next("assign_task", "find_task", 4, 40),
        before("find_task", "assign_task", 30),
        before("assign_task", "find_task", 10),
      ],
    }),
  );
  assert.deepEqual(
    result.proposals.map((p) => p.body.kind),
    ["merge_tools"],
  );
  const draft = result.proposals[0]!;
  assert.ok(
    draft.body.crafted[0]!.dispatch.every((d) => d.when.startsWith("mode = ")),
    "drafted as a mode switch",
  );
  if (draft.evidence.kind === "merge_tools") draft.evidence.merge.timing = TIMING;
  const card = cardOf(draft);

  const gain = gainOf(card, {
    ms: 1000,
    usd: 0.02,
    inputTokens: 4000,
    outputTokens: 100,
    modelCalls: 500,
  });
  assert.deepEqual(
    [gain.calls, gain.roundTrips, gain.ms, gain.usd, gain.tokens],
    [0, 0, 0, null, null],
  );
  const view = suggestionView(card, (id) => id);
  assert.deepEqual(
    view.effects.map((c) => c.text),
    ["−1 entry in every tool list"],
  );
  assert.deepEqual(view.windowEffects, []);
  assert.doesNotMatch(view.effect, /less waiting|one call instead of two/i);
  const [step] = changeOf(view, (id) => id).theirs;
  assert.match(step!, /as its `mode` argument says/);
  assert.doesNotMatch(step!, /in one call/);
  assert.doesNotMatch(draft.body.expectedEffect, /hand-off/);

  // The same pair in sequence still claims its saving.
  const sequenced = await runToolCraft(
    PROJECT,
    reads({
      sets: [pair("find_task", "assign_task", 40, 0.93)],
      edges: [next("find_task", "assign_task", 36, 40), before("find_task", "assign_task", 38)],
    }),
  );
  const seq = sequenced.proposals[0]!;
  if (seq.evidence.kind === "merge_tools") seq.evidence.merge.timing = TIMING;
  assert.deepEqual([gainOf(cardOf(seq)).calls, gainOf(cardOf(seq)).roundTrips], [40, 40]);
  assert.match(
    suggestionView(cardOf(seq), (id) => id)
      .effects.map((c) => c.text)
      .join(" "),
    /2 calls → 1/,
  );
});
