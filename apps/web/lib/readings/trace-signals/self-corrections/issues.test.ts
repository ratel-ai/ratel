import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogEntryOf,
  createIssueStats,
  type IssueEvent,
  type IssueTurn,
  SELF_CORRECTING_KIND,
} from "@/lib/readings/trace-signals/self-corrections/issues";
import { EVIDENCE_TURNS_STORED } from "@/lib/readings/trace-signals/signals/catalog";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";

const FLOORS = { minN: 20, minK: 5, minLow: 0.1 };
const BASE = Date.parse("2026-10-01T00:00:00Z");
let counter = 0;

function issueTurn(over: Partial<IssueTurn> = {}): IssueTurn {
  counter += 1;
  return {
    turnId: `t-${counter.toString().padStart(4, "0")}`,
    endedAt: new Date(BASE + counter * 60_000),
    turnSource: "otlp",
    workflowId: null,
    topicId: null,
    tools: [],
    events: [],
    ...over,
  };
}

const failedAfter = (tool: string, plain: IssueEvent["plain"] = "retried"): IssueEvent => ({
  plain,
  tool,
  pattern: "failed",
  traceEventId: `ev-${tool}`,
});
const backtrackAfter = (tool: string): IssueEvent => ({
  plain: "backtracked",
  tool,
  pattern: "backtrack",
  traceEventId: null,
});

/** `n` turns calling the tools, the first `k` with these events. */
function turns(
  n: number,
  k: number,
  over: Partial<IssueTurn>,
  events: () => IssueEvent[],
): IssueTurn[] {
  return Array.from({ length: n }, (_, i) => issueTurn({ ...over, events: i < k ? events() : [] }));
}

function run(
  all: readonly IssueTurn[],
  tasks: ReadonlyMap<string, readonly string[]> = new Map(),
  topics?: ReadonlyMap<string, string>,
) {
  const stats = createIssueStats();
  for (const turn of all) stats.add(turn);
  return stats.finish({ tasks, topics, floors: FLOORS });
}

test("a tool fires when its share of turns with a self-correction clears the floors", () => {
  const result = run(
    turns(40, 12, { tools: ["update_task"] }, () => [
      failedAfter("update_task"),
      failedAfter("update_task", "gave_up"),
    ]),
  );
  assert.deepEqual([...result.measured], [SELF_CORRECTING_KIND]);
  assert.equal(result.signals.length, 1);
  const [signal] = result.signals;
  assert.equal(signal!.kind, "self_correcting");
  assert.equal(signal!.subjectKind, "tool");
  assert.equal(signal!.subjectKey, "update_task");
  assert.deepEqual(signal!.subjectIds, ["update_task"]);
  assert.equal(signal!.severity, Math.round(wilsonLow(12, 40) * 10_000) / 10_000);
  assert.equal(signal!.impact, 24, "impact counts every self-correction");
  assert.equal(signal!.n, 40);
  assert.equal(signal!.route, "show_turns");
  assert.equal(signal!.metrics.k, 12);
  assert.equal(signal!.metrics.retried, 12);
  assert.equal(signal!.metrics.gaveUp, 12);
  assert.equal(signal!.metrics.pattern, "failed");
  assert.equal(signal!.metrics.fixTool, "update_task");
  assert.equal(signal!.evidence.totalTurns, 12);
});

test("below any floor, nothing fires, and the kind still counts as measured", () => {
  const few = run(turns(19, 10, { tools: ["a"] }, () => [failedAfter("a")]));
  assert.deepEqual(few.signals, [], "fewer turns than minN");
  const rare = run(turns(200, 4, { tools: ["a"] }, () => [failedAfter("a")]));
  assert.deepEqual(rare.signals, [], "fewer affected turns than minK");
  const low = run(turns(200, 12, { tools: ["a"] }, () => [failedAfter("a")]));
  assert.ok(wilsonLow(12, 200) < FLOORS.minLow);
  assert.deepEqual(low.signals, [], "a low bound under minLow");
  assert.deepEqual([...low.measured], ["self_correcting"]);
});

test("a tool counts only the self-corrections that came right after it", () => {
  const result = run(turns(40, 12, { tools: ["find", "update"] }, () => [failedAfter("update")]));
  assert.deepEqual(
    result.signals.map((s) => s.subjectKey),
    ["update"],
    "find was called in the same turns but nothing followed it",
  );
});

test("the fix follows the most common pattern; ties go to failures", () => {
  const backtracks = run(
    turns(40, 12, { tools: ["search_docs"] }, () => [
      backtrackAfter("search_docs"),
      backtrackAfter("search_docs"),
      failedAfter("search_docs"),
    ]),
  );
  assert.equal(backtracks.signals[0]!.metrics.pattern, "backtrack");
  assert.equal(backtracks.signals[0]!.route, "rewrite_description");
  const empty = run(
    turns(40, 12, { tools: ["search_docs"] }, () => [
      { plain: "apologized", tool: "search_docs", pattern: "empty", traceEventId: null },
    ]),
  );
  assert.equal(empty.signals[0]!.metrics.pattern, "empty");
  assert.equal(empty.signals[0]!.route, "workflow_skill");
  const tied = run(turns(40, 12, { tools: ["x"] }, () => [backtrackAfter("x"), failedAfter("x")]));
  assert.equal(tied.signals[0]!.metrics.pattern, "failed");
});

test("a task fires on its runs, names its tool with the most of that pattern, and carries its order", () => {
  const order = ["update_task", "add_task_comment"];
  const all = turns(30, 9, { workflowId: "wf-1", tools: order }, () => [
    failedAfter("update_task"),
    failedAfter("update_task"),
    failedAfter("add_task_comment"),
  ]);
  const result = run(all, new Map([["wf-1", order]]));
  const task = result.signals.find((s) => s.subjectKind === "workflow");
  assert.ok(task);
  assert.equal(task.subjectKey, "wf-1");
  assert.deepEqual(task.subjectIds, order);
  assert.deepEqual(task.subjectDetail, { typicalOrder: order });
  assert.equal(task.metrics.fixTool, "update_task");
  assert.equal(task.metrics.events, 27);
  const unknown = run(all, new Map());
  assert.equal(
    unknown.signals.filter((s) => s.subjectKind === "workflow").length,
    0,
    "a task this run did not mine gets no issue",
  );
});

test("nothing could answer: a task's fix names the topic its unanswered turns were about", () => {
  const unanswered = (): IssueEvent[] => [
    { plain: "apologized", tool: null, pattern: "unanswered", traceEventId: null },
  ];
  const all = [
    ...turns(
      20,
      8,
      { workflowId: "wf-2", topicId: "topic-refunds", tools: ["lookup"] },
      unanswered,
    ),
    ...turns(10, 2, { workflowId: "wf-2", topicId: "topic-other", tools: ["lookup"] }, unanswered),
  ];
  const result = run(
    all,
    new Map([["wf-2", ["lookup"]]]),
    new Map([["topic-refunds", "Refund requests"]]),
  );
  const task = result.signals.find((s) => s.subjectKind === "workflow");
  assert.equal(task?.metrics.pattern, "unanswered");
  assert.equal(task?.metrics.fixTool, null);
  assert.equal(task?.metrics.topicId, "topic-refunds");
  assert.equal(task?.metrics.topicName, "Refund requests");
  assert.equal(
    result.signals.filter((s) => s.subjectKind === "tool").length,
    0,
    "no tool came before them",
  );
});

test("evidence: the newest affected turns, capped, each pointing at the step of its first self-correction", () => {
  const all = turns(80, 30, { tools: ["a"] }, () => [failedAfter("a")]);
  const [signal] = run(all).signals;
  assert.equal(signal!.evidence.turnIds.length, EVIDENCE_TURNS_STORED);
  const affected = all
    .slice(0, 30)
    .map((t) => t.turnId)
    .reverse();
  assert.deepEqual(
    signal!.evidence.turnIds,
    affected.slice(0, EVIDENCE_TURNS_STORED),
    "newest first",
  );
  assert.ok(signal!.evidence.traceEventIds.every((id) => id === "ev-a"));
  assert.deepEqual(signal!.evidence.turnSourceMix, { declared: 0, inferred: 0, otlp: 80 });
  assert.equal(signal!.lane, "otlp");
});

test("a skill is its own subject, named by its catalog id", () => {
  const [signal] = run(
    turns(30, 10, { tools: ["skill:triage"] }, () => [failedAfter("skill:triage")]),
  ).signals;
  assert.equal(signal!.subjectKind, "skill");
  assert.equal(signal!.subjectKey, "skill:triage");
  assert.deepEqual(signal!.subjectIds, ["triage"]);
  assert.equal(signal!.entryKind, "skill");
  assert.deepEqual(catalogEntryOf("skill:triage"), { id: "triage", kind: "skill" });
  assert.deepEqual(catalogEntryOf("update_task"), { id: "update_task", kind: "tool" });
});

test("issues come worst first", () => {
  const all = [
    ...turns(40, 8, { tools: ["mild"] }, () => [failedAfter("mild")]),
    ...turns(40, 30, { tools: ["bad"] }, () => [failedAfter("bad")]),
  ];
  assert.deepEqual(
    run(all).signals.map((s) => s.subjectKey),
    ["bad", "mild"],
  );
});
