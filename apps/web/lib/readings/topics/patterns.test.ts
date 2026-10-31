import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMES_BEFORE_DRAWN,
  COMES_BEFORE_MIN_LIFT,
  COMES_BEFORE_MIN_TURNS,
  COMES_BEFORE_STRONG,
  PATTERN_MIN_TURNS,
  PATTERN_PATH_TOOLS,
  parseStoredPattern,
  topicPatterns,
  withTopicPatterns,
} from "@/lib/readings/topics/patterns";
import type { PlacedTurn } from "@/lib/readings/topics/stats";
import { turn } from "@/lib/readings/topics/test-fixtures";
import type { StoredTopicPattern, TopicInsights, TopicStats } from "@/lib/readings/topics/types";
import {
  PREREQ_MIN_LIFT,
  PREREQ_STRONG_CONFIDENCE,
  PREREQ_USUAL_CONFIDENCE,
} from "@/lib/readings/trace-signals/flow-journey-insights";

/** One placed turn calling `tools` in order (a repeat is a repeat call). */
function placed(
  topicId: string | null,
  tools: string[],
  over: Partial<PlacedTurn["turn"]> = {},
): PlacedTurn {
  return {
    turn: turn({ calls: tools.map((tool) => ({ tool, outcome: "ok" as const })), ...over }),
    verdict: topicId ? "topic" : "none",
    topicId,
    source: "user",
    askHash: null,
    sentiment: null,
    retryOf: null,
  };
}

const times = (n: number, make: () => PlacedTurn): PlacedTurn[] => Array.from({ length: n }, make);

/** A customer-shaped intent: 50 turns; search_tasks in 46, find_documents in 30 (26 of them after search_tasks), filter_tasks in 12, the helper in 48. */
function searchIntent(): PlacedTurn[] {
  return [
    ...times(26, () => placed("t_search", ["search_tasks", "find_documents", "sync"])),
    ...times(2, () => placed("t_search", ["sync", "find_documents", "search_tasks"])),
    ...times(2, () => placed("t_search", ["find_documents"])),
    ...times(12, () => placed("t_search", ["search_tasks", "filter_tasks", "sync"])),
    ...times(6, () => placed("t_search", ["search_tasks", "sync"])),
    ...times(2, () => placed("t_search", ["link_pr", "sync"])),
    // The rest of the project, so search_tasks is not in most of its turns anyway.
    ...times(100, () => placed("t_other", ["x", "y"])),
  ];
}

test("the bars are Agent health's own, imported, with the floor lowered to the intent's", () => {
  assert.equal(COMES_BEFORE_DRAWN, PREREQ_USUAL_CONFIDENCE);
  assert.equal(COMES_BEFORE_STRONG, PREREQ_STRONG_CONFIDENCE);
  assert.equal(COMES_BEFORE_MIN_LIFT, PREREQ_MIN_LIFT);
  assert.equal(COMES_BEFORE_MIN_TURNS, PATTERN_MIN_TURNS);
  assert.equal(PATTERN_MIN_TURNS, 5);
});

test("an intent's pattern is the tools in half its turns, in their usual order, with the helper named apart", () => {
  const pattern = topicPatterns({ placed: searchIntent(), helpers: new Set(["sync"]) }).get(
    "t_search",
  );
  assert.ok(pattern);
  assert.deepEqual(
    pattern.tools,
    [
      { id: "search_tasks", turns: 46 },
      { id: "find_documents", turns: 30 },
    ],
    "46 and 30 of 50; filter_tasks at 12 is under the bar",
  );
  assert.equal(pattern.runs, 28, "turns that ran both");
  assert.equal(pattern.inOrder, 26, "of those, search_tasks first");
  assert.deepEqual(pattern.also, [{ id: "filter_tasks", turns: 12 }], "12 of 50: sometimes");
  assert.deepEqual(pattern.helpers, [{ id: "sync", turns: 48 }]);
  assert.deepEqual(
    pattern.firsts,
    [
      { id: "search_tasks", turns: 44 },
      { id: "find_documents", turns: 4 },
      { id: "link_pr", turns: 2 },
    ],
    "first calls with the helper skipped",
  );
  assert.deepEqual(
    pattern.comesBefore,
    [
      { first: "search_tasks", tool: "find_documents", turns: 30, together: 26 },
      { first: "search_tasks", tool: "filter_tasks", turns: 12, together: 12 },
    ],
    "find_documents before search_tasks is 2 of 46: under the bar; nothing reads through the helper",
  );
  assert.equal(pattern.withCalls, 50);
  assert.deepEqual(pattern.skills, { invoked: 0, offered: 0 });
});

test("a tool the project runs in most turns anyway is not what comes before another", () => {
  const intent = [...times(9, () => placed("t_a", ["a", "b"])), placed("t_a", ["b"])];
  const busy = topicPatterns({
    placed: [...intent, ...times(10, () => placed(null, ["a", "c"]))],
    helpers: new Set(),
  }).get("t_a")!;
  assert.deepEqual(
    busy.comesBefore,
    [],
    "9 of 10 is 90%, but a runs in 19 of 20 turns: a lift of 0.95",
  );
  const quiet = topicPatterns({
    placed: [...intent, ...times(40, () => placed(null, ["c", "d"]))],
    helpers: new Set(),
  }).get("t_a")!;
  assert.deepEqual(
    quiet.comesBefore,
    [{ first: "a", tool: "b", turns: 10, together: 9 }],
    "a in 9 of 50 turns: a lift of 5",
  );
});

test("a step needs five of the intent's turns of the later tool and Agent health's usual share", () => {
  const rows = [
    ...times(4, () => placed("t_a", ["lookup", "update"])),
    ...times(4, () => placed("t_a", ["lookup", "notify"])),
    ...times(2, () => placed("t_a", ["notify", "lookup"])),
    ...times(60, () => placed(null, ["other"])),
  ];
  const pattern = topicPatterns({ placed: rows, helpers: new Set() }).get("t_a")!;
  assert.deepEqual(
    pattern.comesBefore,
    [{ first: "lookup", tool: "notify", turns: 6, together: 4 }],
    "update in 4 turns is under the floor; 4 of 6 is 67%, drawn",
  );
  const loose = topicPatterns({
    placed: [...rows, ...times(2, () => placed("t_a", ["notify"]))],
    helpers: new Set(),
  }).get("t_a")!;
  assert.deepEqual(loose.comesBefore, [], "4 of 8 is 50%: under the usual share");
});

test("fewer than five turns say nothing; no tool in most turns leaves the pattern empty but keeps the first calls", () => {
  const few = topicPatterns({
    placed: times(4, () => placed("t_few", ["a", "b"])),
    helpers: new Set(),
  });
  assert.equal(few.has("t_few"), false);
  const spread = topicPatterns({
    placed: Array.from({ length: 10 }, (_, i) => placed("t_spread", [`t${i % 3}`, `u${i}`])),
    helpers: new Set(),
  }).get("t_spread")!;
  assert.deepEqual(spread.tools, []);
  assert.equal(spread.runs, 0);
  assert.deepEqual(spread.firsts, [
    { id: "t0", turns: 4 },
    { id: "t1", turns: 3 },
    { id: "t2", turns: 3 },
  ]);
});

test("a single tool is a pattern of one, run in order every time it runs", () => {
  const pattern = topicPatterns({
    placed: [
      ...times(6, () => placed("t_one", ["update_task", "update_task"])),
      placed("t_one", ["x"]),
    ],
    helpers: new Set(),
  }).get("t_one")!;
  assert.deepEqual(pattern.tools, [{ id: "update_task", turns: 6 }], "a repeat call is one turn");
  assert.equal(pattern.runs, 6);
  assert.equal(pattern.inOrder, 6);
});

test("model-only traces count among the intent's turns but not in the project's base rate", () => {
  const rows = [
    ...times(6, () => placed("t_m", ["a", "b"])),
    ...times(6, () => placed("t_m", [], { id: `trace:${Math.random()}` })),
    ...times(30, () => placed(null, ["c"])),
  ];
  const pattern = topicPatterns({ placed: rows, helpers: new Set() }).get("t_m")!;
  assert.equal(pattern.withCalls, 6);
  assert.deepEqual(
    pattern.tools,
    [
      { id: "a", turns: 6 },
      { id: "b", turns: 6 },
    ],
    "6 of 12 is half",
  );
  assert.deepEqual(
    pattern.comesBefore,
    [{ first: "a", tool: "b", turns: 6, together: 6 }],
    "a in 6 of 36 ledger turns",
  );
});

test("skill calls and skills offered by a search are counted per turn", () => {
  const rows = [
    ...times(3, () => placed("t_s", ["lookup", "skill:triage"])),
    ...times(2, () => placed("t_s", ["lookup"], { skillOffered: true })),
    ...times(5, () => placed("t_s", ["lookup"])),
  ];
  const pattern = topicPatterns({ placed: rows, helpers: new Set() }).get("t_s")!;
  assert.deepEqual(pattern.skills, { invoked: 3, offered: 2 });
});

test("with no turn running them all, the tools keep their own usual places", () => {
  const rows = [
    ...times(3, () => placed("t_o", ["a", "b"])),
    ...times(3, () => placed("t_o", ["c", "a"])),
    ...times(3, () => placed("t_o", ["b", "x", "c"])),
  ];
  const pattern = topicPatterns({ placed: rows, helpers: new Set() }).get("t_o")!;
  assert.equal(pattern.runs, 0);
  assert.deepEqual(
    pattern.tools.map((tool) => tool.id),
    ["a", "b", "c"],
    "a and b at 0.5 on average, c at 1; ties by id",
  );
});

test("only the first calls of a long turn are read for their order", () => {
  const long = Array.from(
    { length: PATTERN_PATH_TOOLS + 2 },
    (_, i) => `tool_${String(i).padStart(2, "0")}`,
  );
  const rows = [...times(6, () => placed("t_long", long)), ...times(60, () => placed(null, ["z"]))];
  const pattern = topicPatterns({ placed: rows, helpers: new Set() }).get("t_long")!;
  const last = long[long.length - 1]!;
  assert.equal(pattern.tools.length, 6, "at most six pattern tools");
  assert.equal(
    pattern.comesBefore.some((step) => step.tool === last || step.first === last),
    false,
    "a call past the twelfth adds no step",
  );
  assert.ok(pattern.comesBefore.length > 0);
});

test("the reading keeps every row and adds the patterns it has; a stored pattern reads back, a broken one does not", () => {
  const pattern = topicPatterns({ placed: searchIntent(), helpers: new Set(["sync"]) }).get(
    "t_search",
  )!;
  const stats = (id: string) => ({ id, turns: 1 }) as unknown as TopicStats;
  const insights = { topics: [stats("t_search"), stats("t_none")] } as unknown as TopicInsights;
  const read = withTopicPatterns(insights, new Map([["t_search", pattern]]));
  assert.deepEqual(read.topics[0]!.pattern, pattern);
  assert.equal(read.topics[1], insights.topics[1], "a row without a pattern is kept as it is");
  assert.equal(insights.topics[0]!.pattern, undefined, "the input is not changed");
  assert.equal(withTopicPatterns(insights, new Map()), insights);
  assert.deepEqual(parseStoredPattern(JSON.parse(JSON.stringify(pattern))), pattern);
  assert.equal(parseStoredPattern(null), null);
  assert.equal(parseStoredPattern({ ...pattern, tools: [{ id: 3, turns: 1 }] }), null);
  assert.equal(
    parseStoredPattern({ ...pattern, skills: undefined } as unknown as StoredTopicPattern),
    null,
  );
  assert.equal(parseStoredPattern({ ...pattern, runs: -1 }), null);
});
