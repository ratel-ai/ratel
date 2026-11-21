import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlows,
  conversations,
  conversationsLookShared,
  type FlowTurn,
  flowStats,
  nextByTopic,
  SHARED_MIN_PAIRS,
} from "@/lib/readings/topics/flows";
import { T0 } from "@/lib/readings/topics/test-fixtures";
import { FLOW_STARTS, FLOW_TOPICS_PER_STEP } from "@/lib/readings/topics/types";

const MINUTE = 60_000;
let n = 0;

function ft(key: string, at: number, over: Partial<FlowTurn> = {}): FlowTurn {
  n += 1;
  return {
    id: `f${n}`,
    sessionId: "s1",
    endUserKey: null,
    startedAt: new Date(at),
    endedAt: new Date(at + 30_000),
    key,
    answered: true,
    calls: [{ tool: "lookup", outcome: "ok" }],
    ...over,
  };
}

test("a conversation is one user's turns in a session, cut where they were quiet too long", () => {
  const a1 = ft("t1", T0);
  const a2 = ft("t2", T0 + 2 * MINUTE);
  const b1 = ft("t1", T0 + MINUTE, { endUserKey: "u2" });
  const a3 = ft("t3", T0 + 60 * MINUTE);
  const list = conversations([a3, b1, a2, a1], 10 * MINUTE);
  assert.deepEqual(
    list.map((c) => c.map((t) => t.id)),
    [[a1.id, a2.id], [b1.id], [a3.id]],
  );
});

test("each step names its busiest topics, folds the rest into Other, and counts who ended there", () => {
  const list = [
    [ft("pay", T0), ft("retry", T0 + MINUTE), ft("pay", T0 + 2 * MINUTE)],
    [ft("pay", T0 + 10), ft("delivery", T0 + MINUTE)],
    [ft("delivery", T0 + 20, { answered: false, calls: [{ tool: "track", outcome: "error" }] })],
    [ft("other", T0 + 30), ft("pay", T0 + MINUTE)],
  ];
  const flows = flowStats(list, 4);
  assert.equal(flows.sessions, 4);
  assert.equal(flows.multiTurn, 3);
  assert.equal(flows.wentOn, 0);
  assert.deepEqual(
    flows.columns.map((c) => [c.position, c.sessions, c.ended]),
    [
      [1, 4, 1],
      [2, 3, 2],
      [3, 1, 1],
    ],
  );
  const step1 = flows.columns[0]!;
  assert.deepEqual(
    step1.nodes.map((node) => [node.key, node.sessions, node.ended, node.unanswered]),
    [
      ["pay", 2, 0, 0],
      ["delivery", 1, 1, 1],
      ["other", 1, 0, 0],
    ],
  );
  assert.deepEqual(step1.nodes[0]!.next, [
    { key: "delivery", sessions: 1 },
    { key: "retry", sessions: 1 },
  ]);
  assert.deepEqual(step1.nodes[1]!.tools, [{ id: "track", calls: 1, failures: 1 }]);
  assert.deepEqual(
    flows.columns[1]!.nodes.map((node) => node.key),
    ["delivery", "pay", "retry"],
    "topics, then Asked again",
  );
});

test("a conversation longer than the steps drawn went on", () => {
  const long = [ft("a", T0), ft("b", T0 + 1), ft("c", T0 + 2), ft("d", T0 + 3), ft("e", T0 + 4)];
  const flows = flowStats([long], 4);
  assert.equal(flows.wentOn, 1);
  assert.deepEqual(
    flows.columns.map((c) => c.ended),
    [0, 0, 0, 0],
  );
  assert.deepEqual(flows.columns[3]!.nodes[0]!.next, [], "no step past the last one");
});

test("past five at a step, the quieter ones join Other, so a step reads at a glance", () => {
  assert.equal(FLOW_TOPICS_PER_STEP, 5);
  const list = Array.from({ length: 10 }, (_, i) => [ft(`t${i}`, T0 + i)]);
  const flows = flowStats(list, 4);
  assert.deepEqual(
    flows.columns[0]!.nodes.map((node) => node.key),
    ["t0", "t1", "t2", "t3", "t4", "other"],
  );
  assert.equal(flows.columns[0]!.nodes.at(-1)!.sessions, 5);
});

test("every first ask a step names can be followed", () => {
  assert.equal(FLOW_STARTS, FLOW_TOPICS_PER_STEP);
  const list = Array.from({ length: 7 }, (_, i) =>
    Array.from({ length: 7 - i }, () => [ft(`t${i}`, T0 + i)]),
  ).flat();
  const flows = buildFlows(list);
  assert.deepEqual(flows.starts, ["t0", "t1", "t2", "t3", "t4"]);
  assert.deepEqual(
    flows.all.columns[0]!.nodes.slice(0, 5).map((node) => node.key),
    flows.starts,
  );
});

test("conversations whose asks overlap are shared by several people; one person's never are", () => {
  const overlapping = Array.from({ length: SHARED_MIN_PAIRS + 1 }, (_, i) =>
    ft("t1", T0 + i * 10_000),
  );
  assert.equal(
    conversationsLookShared([overlapping]),
    true,
    "each ask starts before the one before ended",
  );
  const inTurn = Array.from({ length: SHARED_MIN_PAIRS + 1 }, (_, i) => ft("t1", T0 + i * MINUTE));
  assert.equal(conversationsLookShared([inTurn]), false);
  assert.equal(conversationsLookShared([overlapping.slice(0, 3)]), false, "too few to tell");
  const typedAhead = ft("t1", inTurn.at(-1)!.endedAt.getTime() - 1);
  assert.equal(
    conversationsLookShared([[...inTurn, typedAhead]]),
    false,
    "an odd overlap is a person typing ahead",
  );
});

test("views are precomputed for every conversation and for each busiest starting topic", () => {
  const list = [
    [ft("pay", T0), ft("delivery", T0 + 1)],
    [ft("pay", T0 + 2)],
    [ft("delivery", T0 + 3)],
    [ft("retry", T0 + 4)],
  ];
  const flows = buildFlows(list);
  assert.deepEqual(flows.starts, ["pay", "delivery"], "Asked again and Other never start a view");
  assert.equal(flows.byStart.pay!.sessions, 2);
  assert.equal(flows.byStart.delivery!.sessions, 1);
  assert.equal(flows.all.sessions, 4);
});

test("what people ask next after a topic, anywhere in the conversation", () => {
  const list = [[ft("pay", T0), ft("pay", T0 + 1), ft("retry", T0 + 2)], [ft("pay", T0 + 3)]];
  const next = nextByTopic(list, 5);
  assert.deepEqual(next.get("pay"), [
    { key: "ended", sessions: 1 },
    { key: "pay", sessions: 1 },
    { key: "retry", sessions: 1 },
  ]);
});
