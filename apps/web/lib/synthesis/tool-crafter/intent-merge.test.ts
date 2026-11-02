import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExplorerEdge, ExplorerSet } from "@/lib/readings/tool-explorer/types";
import { FIXED_PAIR_ORDER } from "@/lib/readings/trace-signals/workflows/fixed-order";
import type { Candidate } from "@/lib/synthesis/match-quality/types";
import { craftKey } from "@/lib/synthesis/tool-crafter/craft-key";
import {
  INTENT_MERGE_MIN_RUNS,
  INTENT_MERGE_MIN_SHARE,
  type IntentPatternFact,
  pickIntentMergeCandidates,
} from "@/lib/synthesis/tool-crafter/intent-merge";
import { INTENT_MERGE_PLAIN } from "@/lib/synthesis/tool-crafter/kinds";
import { type CraftRunReads, runToolCraft } from "@/lib/synthesis/tool-crafter/pipeline";
import { withoutDismissed } from "@/lib/synthesis/tool-crafter/queries";
import { suggestionView } from "@/lib/synthesis/tool-crafter/suggestion-model";
import type { SourceTool } from "@/lib/synthesis/tool-crafter/types";
import { type CraftCardModel, cardSummary } from "@/lib/synthesis/tool-crafter/view";

/**
 * Tool Craft's merge of an intent's own two-tool pattern: the rule's floors
 * (ten turns running both, half the intent's turns, a fixed order by the one
 * rule read for a pair over the turns that ran both), the intent as evidence
 * by id, its place last in a run, and the same change as a project-wide
 * merge of the two tools being one proposal and one dismissal.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";

function intent(
  turns: number,
  pattern: Partial<IntentPatternFact["pattern"]> = {},
  topicId = "t_tasks",
): IntentPatternFact {
  return {
    topicId,
    turns,
    pattern: {
      tools: [
        { id: "search_projects", turns: 40 },
        { id: "create_task", turns: 38 },
      ],
      runs: 36,
      inOrder: 35,
      ...pattern,
    },
  };
}

const pairOf = (a: string, b: string, n: number) => [
  { id: a, turns: n },
  { id: b, turns: n },
];

test("an intent's two-tool pattern is a merge, in the pattern's order, with the intent as evidence", () => {
  const [merge] = pickIntentMergeCandidates([intent(54)]);
  assert.ok(merge);
  assert.deepEqual([merge.a, merge.b], ["search_projects", "create_task"]);
  const e = merge.evidence;
  assert.deepEqual(
    [e.scope, e.support, e.unitsA, e.unitsB, e.orderAb, e.orderBa],
    ["turn", 36, 40, 38, 35, 1],
  );
  assert.equal(e.jaccard, 36 / 42, "36 of the 42 turns that ran either");
  assert.equal(e.nextP, 35 / 36);
  assert.deepEqual(
    e.intent,
    { topicId: "t_tasks", turns: 54, runs: 36 },
    "by id: no name, no ask text",
  );
  assert.deepEqual(e.exampleSessions, []);
});

test("the floors: half the intent's turns, the one rule's order over the turns that ran both, two tools", () => {
  assert.equal(INTENT_MERGE_MIN_RUNS, 10);
  assert.equal(INTENT_MERGE_MIN_SHARE, 0.5);
  assert.equal(
    pickIntentMergeCandidates([intent(18, { tools: pairOf("a", "b", 9), runs: 9, inOrder: 9 })])
      .length,
    0,
    "9 turns running both",
  );
  assert.equal(
    pickIntentMergeCandidates([intent(80, { tools: pairOf("a", "b", 39), runs: 39, inOrder: 39 })])
      .length,
    0,
    "39 of 80 is under half",
  );
  assert.equal(
    pickIntentMergeCandidates([intent(54, { inOrder: 30 })]).length,
    0,
    "30 of 36 in order is under the one rule's nine in ten",
  );
  const under = FIXED_PAIR_ORDER.minRuns - 1;
  assert.equal(
    pickIntentMergeCandidates([
      intent(30, { tools: pairOf("a", "b", under), runs: under, inOrder: under }),
    ]).length,
    0,
    "the one rule reads its 20 runs over the turns that ran both",
  );
  assert.equal(
    pickIntentMergeCandidates([intent(30, { tools: pairOf("a", "b", 20), runs: 20, inOrder: 20 })])
      .length,
    1,
  );
  assert.equal(
    pickIntentMergeCandidates([
      intent(54, { tools: [...pairOf("a", "b", 40), { id: "c", turns: 40 }] }),
    ]).length,
    0,
    "three tools are no merge of two",
  );
  assert.equal(
    pickIntentMergeCandidates([
      intent(54, {
        tools: [
          { id: "skill:triage", turns: 40 },
          { id: "b", turns: 38 },
        ],
      }),
    ]).length,
    0,
    "a skill is not merged",
  );
});

test("one proposal per tool, most turns first, ties by the tools' ids then the intent's; a tool another proposal took is skipped", () => {
  const big = intent(60, { runs: 40, inOrder: 40 }, "t_big");
  const small = intent(
    40,
    { tools: pairOf("create_task", "notify", 25), runs: 22, inOrder: 22 },
    "t_small",
  );
  assert.deepEqual(
    pickIntentMergeCandidates([small, big]).map((m) => m.evidence.intent?.topicId),
    ["t_big"],
    "create_task goes to the bigger intent",
  );
  assert.deepEqual(
    pickIntentMergeCandidates([small, big], new Set(["search_projects"])).map(
      (m) => m.evidence.intent?.topicId,
    ),
    ["t_small"],
  );
  const ab = intent(40, { tools: pairOf("a", "b", 30), runs: 30, inOrder: 30 }, "t_y");
  const ac = intent(40, { tools: pairOf("a", "c", 30), runs: 30, inOrder: 30 }, "t_x");
  for (const order of [
    [ab, ac],
    [ac, ab],
  ]) {
    assert.deepEqual(
      pickIntentMergeCandidates(order).map((m) => [m.a, m.b]),
      [["a", "b"]],
      "the same answer whatever the input order",
    );
  }
});

const source = (id: string, description: string): SourceTool => ({
  id,
  name: id,
  description,
  searchableDescription: null,
  inputSchema: {
    type: "object",
    properties: { [`${id}_arg`]: { type: "string" } },
    required: [`${id}_arg`],
  },
});
const SOURCES = [
  source("search_projects", "Search projects by name."),
  source("create_task", "Create a task in a project."),
  source("notify", "Notify someone."),
];

function reads(
  intents: IntentPatternFact[],
  over: { sets?: ExplorerSet[]; edges?: ExplorerEdge[]; deficits?: Candidate[] } = {},
): CraftRunReads {
  return {
    loadExplorer: async () => ({
      runId: "run-1",
      windowDays: 30,
      sets: over.sets ?? [],
      pairs: over.sets ?? [],
      edges: over.edges ?? [],
      nodes: [],
    }),
    loadSources: async () => SOURCES,
    loadDeficits: async () => over.deficits ?? [],
    loadIntentPatterns: async () => intents,
  };
}

test("a crafting run drafts the intent's merge, worded on the intent's turns, retiring nothing", async () => {
  const result = await runToolCraft(
    PROJECT,
    reads([
      intent(54),
      intent(40, { tools: pairOf("ghost", "notify", 30), runs: 28, inOrder: 28 }, "t_ghost"),
    ]),
  );
  assert.deepEqual(
    result.proposals.map((p) => [p.body.kind, p.body.sourceToolIds]),
    [["merge_tools", ["search_projects", "create_task"]]],
  );
  const draft = result.proposals[0]!;
  assert.equal(
    draft.evidence.kind === "merge_tools" ? draft.evidence.merge.intent?.topicId : null,
    "t_tasks",
  );
  assert.equal(
    draft.body.rationale,
    "search_projects and create_task ran together in 36 of one intent's 54 turns (67%), search_projects first in 35 of them: one call can do both for that intent.",
  );
  assert.ok(
    draft.body.crafted[0]!.dispatch.every((step) => !step.when.startsWith("mode")),
    "sequenced: one call runs both in order",
  );
  assert.deepEqual(
    draft.body.hidden,
    [],
    "other intents may still run either alone: nothing is retired",
  );
  assert.match(
    draft.body.migrationNotes,
    /Keep search_projects and create_task registered: other intents may still call them on their own\./,
  );
  assert.deepEqual(result.candidates, [
    {
      kind: "merge_tools",
      tools: ["ghost", "notify"],
      outcome: "dropped",
      reason: "source tool not in the runtime catalog",
    },
    { kind: "merge_tools", tools: ["search_projects", "create_task"], outcome: "proposed" },
  ]);
  const card: CraftCardModel = {
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
  };
  assert.equal(
    cardSummary(card).why[0],
    "search_projects and create_task ran together in 67% of the intent's 54 turns (36 times), search_projects first in 97% of them.",
  );
  assert.equal(
    suggestionView(card, (id) => id).plain,
    INTENT_MERGE_PLAIN,
    'not "always used together": only in this intent, and both stay',
  );
});

test("a pair naming a tool the runtime no longer declares claims no tool from a pair that is real", async () => {
  const ghost = intent(
    60,
    { tools: pairOf("ghost", "notify", 45), runs: 45, inOrder: 45 },
    "t_ghost",
  );
  const real = intent(
    50,
    { tools: pairOf("notify", "create_task", 30), runs: 30, inOrder: 30 },
    "t_real",
  );
  const result = await runToolCraft(PROJECT, reads([ghost, real]));
  assert.deepEqual(
    result.proposals.map((p) => p.body.sourceToolIds),
    [["notify", "create_task"]],
  );
});

test("intent merges come last: a tool another rule claimed keeps its proposal", async () => {
  const deficit: Candidate = {
    entryId: "create_task",
    name: "create_task",
    misses: 6,
    buried: 0,
    targeted: 8,
    distractions: 0,
    loss: 6,
    failures: ["make a todo item for the client", "open a ticket for the plumber"].map((query) => ({
      query,
      ourRank: null,
      ourTop: "search_projects",
      baselineTop: "create_task",
      targetSource: "observed" as never,
    })),
  };
  const result = await runToolCraft(PROJECT, reads([intent(54)], { deficits: [deficit] }));
  assert.deepEqual(
    result.proposals.map((p) => [p.body.kind, p.body.sourceToolIds]),
    [["rewrite_tool", ["create_task"]]],
    "the rewrite drafted before intent merges existed stays",
  );
});

test("a pair the project-wide rule merges too is one proposal: the project-wide one, nominated first", async () => {
  const set: ExplorerSet = {
    scope: "turn",
    subject: "tool",
    key: "create_task|search_projects",
    items: ["create_task", "search_projects"],
    size: 2,
    support: 80,
    share: 0.3,
    jaccard: 0.96,
    jaccardLow: 0.92,
    pAb: 1,
    pBa: 0.97,
    workflowId: null,
    exampleSessions: [],
  };
  const edge = (kind: "next" | "before"): ExplorerEdge => ({
    scope: "turn",
    kind,
    subject: "tool",
    a: "search_projects",
    b: "create_task",
    n: 76,
    nA: 80,
    p: 0.95,
    pLow: 0,
    pHigh: 1,
    lift: 3,
    reverseN: 0,
    exampleSessions: [],
  });
  const result = await runToolCraft(
    PROJECT,
    reads([intent(54)], { sets: [set], edges: [edge("next"), edge("before")] }),
  );
  assert.equal(result.proposals.length, 1);
  assert.equal(
    result.proposals[0]!.evidence.kind === "merge_tools"
      ? result.proposals[0]!.evidence.merge.intent
      : "other",
    undefined,
    "the project-wide evidence",
  );
  assert.deepEqual(
    result.candidates.map((c) => c.outcome),
    ["proposed"],
    "the intent's pick saw the tools taken and nominated nothing",
  );
});

test("a dismissal is kept by kind and tools, so dismissing either merge keeps the other away", () => {
  const dismissed = new Set([craftKey("merge_tools", ["create_task", "search_projects"])]);
  const drafts = [
    { body: { kind: "merge_tools", sourceToolIds: ["search_projects", "create_task"] } },
    { body: { kind: "merge_tools", sourceToolIds: ["search_projects", "notify"] } },
  ];
  assert.deepEqual(
    withoutDismissed(drafts, dismissed).map((d) => d.body.sourceToolIds),
    [["search_projects", "notify"]],
  );
});
