import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import type { ExplorerEdge, ExplorerNode, ExplorerSet } from "@/lib/readings/tool-explorer/types";
import type { ReplayCase } from "@/lib/synthesis/match-quality/replay";
import { backtestCraft, craftedCorpus, targetMapping } from "@/lib/synthesis/tool-crafter/backtest";
import {
  pickDeprecateCandidates,
  pickFoldCandidates,
} from "@/lib/synthesis/tool-crafter/candidates";
import { draftDeprecate, draftFold, draftMerge } from "@/lib/synthesis/tool-crafter/draft";
import { checkProposal } from "@/lib/synthesis/tool-crafter/schema-check";
import type { SourceTool } from "@/lib/synthesis/tool-crafter/types";

const tool = (
  id: string,
  description: string,
  properties: Record<string, { type: string; description?: string }>,
  required: string[] = [],
): SourceTool => ({
  id,
  name: id,
  description,
  searchableDescription: null,
  inputSchema: { type: "object", properties, required },
});
const lookup = tool(
  "lookup_project",
  "Look up a project by name. Returns its id.",
  { name: { type: "string" } },
  ["name"],
);
const report = tool(
  "weekly_report",
  "Produce the weekly report for a project.",
  { projectId: { type: "string" }, week: { type: "string" } },
  ["projectId"],
);
const big = tool(
  "manage_task",
  "Create, update or comment on a task.",
  {
    taskId: { type: "string" },
    title: { type: "string", description: "Title for a new task" },
    comment: { type: "string", description: "Comment text to add" },
    assignee: { type: "string", description: "Who to assign" },
  },
  ["taskId"],
);
const CATALOG = new Set([
  "lookup_project",
  "weekly_report",
  "manage_task",
  "search_tasks",
  "create_tasks_batch",
]);

const pair = (a: string, b: string, support: number, pAb: number, pBa: number): ExplorerSet => ({
  scope: "turn",
  subject: "tool",
  key: [a, b].sort().join("|"),
  items: [a, b].sort(),
  size: 2,
  support,
  share: 0.2,
  jaccard: 0.5,
  jaccardLow: 0.4,
  pAb: [a, b].sort()[0] === a ? pAb : pBa,
  pBa: [a, b].sort()[0] === a ? pBa : pAb,
  workflowId: null,
  exampleSessions: [],
});
const before = (a: string, b: string, n: number): ExplorerEdge => ({
  scope: "turn",
  kind: "before",
  subject: "tool",
  a,
  b,
  n,
  nA: n,
  p: 1,
  pLow: 0,
  pHigh: 1,
  lift: 2,
  reverseN: 0,
  exampleSessions: [],
});
const nextEdge = (a: string, b: string, n: number, nA: number): ExplorerEdge => ({
  ...before(a, b, n),
  kind: "next",
  nA,
  p: n / nA,
});

test("pickFoldCandidates finds the lookup that only ever precedes one tool, and draftFold folds it in as optional input", () => {
  const edges = [
    before("lookup_project", "weekly_report", 29),
    before("weekly_report", "lookup_project", 1),
    nextEdge("lookup_project", "weekly_report", 28, 31),
  ];
  const picked = pickFoldCandidates(
    [pair("lookup_project", "weekly_report", 30, 0.97, 0.4)],
    edges,
    new Set(),
  );
  assert.deepEqual(
    picked.map((f) => [f.a, f.b]),
    [["lookup_project", "weekly_report"]],
  );
  assert.deepEqual([picked[0]!.evidence.unitsA, picked[0]!.evidence.unitsB], [31, 75]);
  assert.equal(
    pickFoldCandidates([pair("lookup_project", "weekly_report", 30, 0.97, 0.9)], [], new Set())
      .length,
    0,
    "both sides bound is a merge, not a fold",
  );
  assert.equal(
    pickFoldCandidates(
      [pair("lookup_project", "weekly_report", 30, 0.97, 0.4)],
      [before("weekly_report", "lookup_project", 20)],
      new Set(),
    ).length,
    0,
    "the lookup must come first",
  );
  assert.equal(
    pickFoldCandidates(
      [pair("lookup_project", "weekly_report", 30, 0.97, 0.4)],
      [
        before("lookup_project", "weekly_report", 29),
        nextEdge("lookup_project", "weekly_report", 5, 31),
      ],
      new Set(),
    ).length,
    0,
    "a tool three steps on is not a lookup feeding the next call",
  );

  const body = draftFold({
    a: lookup,
    b: report,
    evidence: picked[0]!.evidence,
    catalogIds: CATALOG,
  });
  assert.equal(body.kind, "fold_prerequisite");
  const [crafted] = body.crafted;
  assert.equal(crafted!.name, "weekly_report_by_lookup");
  assert.deepEqual(Object.keys(crafted!.inputSchema.properties!).sort(), [
    "name",
    "projectId",
    "week",
  ]);
  assert.deepEqual(
    crafted!.inputSchema.required,
    ["projectId"],
    "the main tool's requirements stand; the lookup's input is the alternative",
  );
  assert.match(crafted!.description, /Give `name` instead of weekly_report's own identifier/);
  assert.deepEqual(body.hidden, ["lookup_project"]);
  assert.match(body.rationale, /97% of its 31 turns went on to weekly_report/);
  assert.equal(checkProposal([lookup, report], body, CATALOG).ok, true);
});

test("pickDeprecateCandidates retires a declared tool nothing called when a used look-alike exists, and the draft names it", () => {
  const sources = [
    big,
    tool("search_tasks", "Search tasks.", {}),
    tool("create_tasks_batch", "Create many tasks.", {}),
    tool("lonely_thing", "Nothing like it.", {}),
  ];
  const nodes: ExplorerNode[] = [
    { id: "search_tasks", subject: "tool", calls: 130, turnUnits: 130, sessionUnits: 130 },
    { id: "manage_task", subject: "tool", calls: 20, turnUnits: 20, sessionUnits: 20 },
  ];
  const picked = pickDeprecateCandidates(sources, nodes, 90, new Set());
  assert.deepEqual(
    picked.map((d) => [d.toolId, d.replacement, d.evidence.sharedWords]),
    [["create_tasks_batch", "search_tasks", ["task"]]],
    "lonely_thing shares no words with a used tool and is left alone; stems make tasks and task one word",
  );
  assert.equal(
    pickDeprecateCandidates(sources, nodes, 14, new Set()).length,
    0,
    "two weeks is too short to call a tool dead",
  );
  const body = draftDeprecate({
    tool: sources[2]!,
    replacement: sources[1]!,
    evidence: picked[0]!.evidence,
  });
  assert.deepEqual([body.crafted, body.hidden], [[], ["create_tasks_batch"]]);
  assert.match(
    body.rationale,
    /never called in 90 days, while search_tasks, which shares its words \(task\), ran 130 times/,
  );
  assert.match(body.migrationNotes, /use `search_tasks` instead/);
  assert.equal(checkProposal([sources[2]!], body, CATALOG).ok, true);
});

const entry = (id: string, searchable: string): CorpusEntry => ({
  entryId: id,
  name: id,
  searchable,
  description: searchable,
  source: "runtime",
  matchesAgentDescription: true,
  tags: [],
});
const kase = (query: string, target: string): ReplayCase => ({
  queryKey: query,
  query,
  targetEntryId: target,
  source: "observed" as never,
  servedIds: null,
  baselineIds: null,
  occurredAt: new Date("2026-09-01T00:00:00Z"),
});

test("the backtest replays labelled searches over the crafted corpus with targets mapped through the proposal", () => {
  const corpus = [
    entry("find_task", "find task by title"),
    entry("assign_task", "assign task to teammate"),
    entry("list_projects", "list projects workspaces"),
  ];
  const find = tool("find_task", "Find a task by title.", { query: { type: "string" } }, ["query"]);
  const assign = tool(
    "assign_task",
    "Assign a task to a teammate.",
    { taskId: { type: "string" } },
    ["taskId"],
  );
  const merge = draftMerge({
    a: find,
    b: assign,
    evidence: {
      scope: "turn",
      support: 40,
      unitsA: 40,
      unitsB: 40,
      jaccard: 1,
      jaccardLow: 0.91,
      pAb: 1,
      pBa: 1,
      nextP: 0.9,
      orderAb: 36,
      orderBa: 2,
      exampleSessions: [],
    },
    catalogIds: new Set(corpus.map((c) => c.entryId)),
  });
  assert.deepEqual(
    craftedCorpus(corpus, merge).map((c) => c.entryId),
    ["list_projects", "find_assign_task"],
  );
  assert.deepEqual(targetMapping(merge).mapping, {
    find_task: "find_assign_task",
    assign_task: "find_assign_task",
  });

  const cases = [
    kase("find the task about billing", "find_task"),
    kase("assign the task to sam", "assign_task"),
    kase("list my workspaces", "list_projects"),
  ];
  const result = backtestCraft(corpus, cases, merge);
  assert.equal(result.n, 3);
  assert.equal(result.affectedN, 2);
  assert.equal(result.before.contained, 3);
  assert.equal(result.after.contained, 3, "the merged tool still answers both asks");
  assert.ok(result.delta.quality !== null && result.delta.interval !== null);
  assert.ok(result.caveats.some((c) => /Retrieval only/.test(c)));

  const retire = draftDeprecate({
    tool: assign,
    replacement: find,
    evidence: {
      windowDays: 90,
      calls: 0,
      replacement: "find_task",
      replacementCalls: 10,
      sharedWords: ["task"],
    },
  });
  const retired = backtestCraft(corpus, cases, retire);
  assert.deepEqual(targetMapping(retire).mapping, { assign_task: "find_task" });
  assert.equal(retired.affectedN, 1);
  assert.deepEqual(
    craftedCorpus(corpus, retire).map((c) => c.entryId),
    ["find_task", "list_projects"],
  );
});
