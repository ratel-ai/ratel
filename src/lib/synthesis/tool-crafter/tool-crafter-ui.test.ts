import assert from "node:assert/strict";
import { test } from "node:test";
import { draftMerge } from "@/lib/synthesis/tool-crafter/draft";
import { toPythonStub, toToolJson, toTypeScriptStub } from "@/lib/synthesis/tool-crafter/export";
import type { ToolCraftProposalRow } from "@/lib/synthesis/tool-crafter/schema";
import { orderSuggestions, suggestionView } from "@/lib/synthesis/tool-crafter/suggestion-model";
import type { SourceTool } from "@/lib/synthesis/tool-crafter/types";
import { cardModel } from "@/lib/synthesis/tool-crafter/view";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const find: SourceTool = {
  id: "find_task",
  name: "find_task",
  description: "Find a task by its title or key.",
  searchableDescription: "find task title key",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    required: ["query"],
  },
};
const assign: SourceTool = {
  id: "assign_task",
  name: "assign_task",
  description: "Assign a task to a teammate.",
  searchableDescription: "assign task teammate",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      assignee: { type: "string" },
      limit: { type: "string" },
    },
    required: ["taskId", "assignee"],
  },
};
const body = draftMerge({
  a: find,
  b: assign,
  evidence: {
    scope: "turn",
    support: 40,
    unitsA: 40,
    unitsB: 41,
    jaccard: 0.98,
    jaccardLow: 0.91,
    pAb: 1,
    pBa: 0.98,
    nextP: 0.95,
    orderAb: 38,
    orderBa: 2,
    exampleSessions: [],
  },
  catalogIds: new Set(["find_task", "assign_task"]),
});

function row(over: Partial<ToolCraftProposalRow> = {}): ToolCraftProposalRow {
  return {
    id: "p1",
    runId: "r1",
    projectId: PROJECT_ID,
    kind: body.kind,
    status: "pending",
    sourceToolIds: body.sourceToolIds,
    sourceDefinitions: [find, assign] as unknown as Record<string, unknown>[],
    crafted: body.crafted as unknown as Record<string, unknown>[],
    hiddenToolIds: body.hidden,
    rationale: body.rationale,
    details: body.details,
    expectedEffect: body.expectedEffect,
    migrationNotes: body.migrationNotes,
    evidence: {},
    backtest: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

test("the export stubs carry the name, both descriptions, the schema and the dispatch notes", () => {
  const tool = body.crafted[0]!;
  const json = JSON.parse(toToolJson(tool));
  assert.equal(json.name, "find_assign_task");
  assert.deepEqual(json.inputSchema.required, ["assignee", "query", "taskId"]);
  const ts = toTypeScriptStub(tool);
  assert.match(ts, /runtime\.tools\.register\(\{/);
  assert.match(ts, /id: "find_assign_task"/);
  assert.match(ts, /\/\/ find_task: always, as the first step/);
  assert.match(
    ts,
    /const r_find_task = await find_task\(\{ \.\.\.args, "limit": args\["find_task_limit"\] \}\);/,
    "the handler calls the first source with the renamed argument",
  );
  assert.match(ts, /return await assign_task\(/);
  const py = toPythonStub(tool);
  assert.match(py, /def find_assign_task\(\*\*args\):/);
  assert.match(py, /catalog\.register\(/);
  assert.doesNotMatch(py, /\btrue\b|\bnull\b/, "JSON literals become Python ones");
});

test("the explorer's suggestion view: verb, headline, the one figure, why, the asks it serves, and the order by effect", () => {
  const timing = {
    aCalls: 69,
    bCalls: 70,
    aMedianMs: 400,
    bMedianMs: 1200,
    aTotalMs: 27_600,
    bTotalMs: 84_000,
    handoffPairs: 69,
    handoffMsTotal: 49_657,
    handoffMsMedian: 686,
    searchesBetween: 0,
  };
  const merge = cardModel(
    row({
      evidence: {
        kind: "merge_tools",
        merge: {
          scope: "turn",
          support: 69,
          unitsA: 69,
          unitsB: 70,
          jaccard: 0.99,
          jaccardLow: 0.95,
          pAb: 1,
          pBa: 0.99,
          nextP: 1,
          orderAb: 69,
          orderBa: 0,
          exampleSessions: [],
          timing,
        },
      } as unknown as Record<string, unknown>,
    }),
  );
  const retire = cardModel(
    row({
      id: "p2",
      kind: "deprecate_tool",
      sourceToolIds: ["create_task"],
      sourceDefinitions: [{ ...find, id: "create_task", name: "create_task" }] as unknown as Record<
        string,
        unknown
      >[],
      crafted: [],
      evidence: {
        kind: "deprecate_tool",
        deprecate: {
          windowDays: 30,
          calls: 0,
          replacement: "search_tasks",
          replacementCalls: 110,
          sharedWords: ["task"],
        },
      } as unknown as Record<string, unknown>,
    }),
  );
  const intents = [
    {
      intentId: "i1",
      text: "assign task to member",
      units: 34,
      groupLabel: null,
      chains: [],
      calls: 0,
      tools: [
        { toolId: "find_task", n: 34, share: 1, shareLow: 0.9 },
        { toolId: "assign_task", n: 34, share: 1, shareLow: 0.9 },
      ],
    },
    {
      intentId: "i2",
      text: "who owns the ticket",
      units: 20,
      groupLabel: null,
      chains: [],
      calls: 0,
      tools: [
        { toolId: "find_task", n: 12, share: 0.6, shareLow: 0.4 },
        { toolId: "assign_task", n: 4, share: 0.2, shareLow: 0.1 },
      ],
    },
  ];
  const name = (id: string) => id;
  const m = suggestionView(merge, name, intents);
  assert.equal(m.verb, "Merge");
  assert.match(m.headline, /find_task.*assign_task/);
  assert.deepEqual(
    m.figure,
    { value: "−686 ms", caption: "request time", measured: true },
    "the hand-off is 686 of 2,286 ms",
  );
  assert.deepEqual(
    m.effects.map((c) => c.text),
    ["2 calls → 1", "−1 round-trip", "−686 ms waiting (−30%)"],
  );
  assert.deepEqual(
    [m.unit, m.windowLabel, m.windowEffects.map((c) => c.text)],
    ["per request", "over the window · 69 times together", ["−69 round-trips", "−50 s waiting"]],
  );
  assert.match(m.plain, /always used together, so make them one tool/);
  assert.deepEqual(
    m.facts.map((f) => f.label),
    ["run together", "times", "waited in total"],
  );
  assert.match(m.why, /99%/, "the why line carries the jaccard");
  assert.deepEqual(
    m.asks.map((a) => a.intentId),
    ["i1"],
    "i2 calls assign_task in only 20% of its units",
  );
  assert.equal(m.savingMs, 49_657);
  const r = suggestionView(retire, name, intents);
  assert.equal(r.verb, "Retire");
  assert.deepEqual(r.figure, { value: "0 calls", caption: "30 days", measured: true });
  assert.deepEqual(
    r.effects.map((c) => c.text),
    ["−1 entry in every tool list"],
  );
  assert.deepEqual(
    orderSuggestions([r, m]).map((v) => v.id),
    ["p1", "p2"],
    "the measured saving comes first",
  );

  assert.deepEqual(
    m.brief.map((c) => c.text),
    ["2 calls → 1", "−686 ms/request waiting (−30%)", "−69 round-trips total"],
    "unpriced: four figures at most, round-trips standing in for tokens",
  );
  assert.deepEqual(
    m.glance.map((c) => [c.icon, c.text]),
    [
      ["calls", "2 → 1"],
      ["model", "−69"],
    ],
    "closed: icon and number only; unpriced, round-trips stand in for dollars",
  );

  // The drafted changes are listed and opened on Fixes now (lib/fixes, fixes-view.test.ts).
});
