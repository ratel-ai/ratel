import assert from "node:assert/strict";
import { test } from "node:test";
import { seedState } from "@/lib/readings/intent-engine/seed";
import type { IntentGraphDocument, IntentGraphIntent } from "@/lib/readings/intent-types/wire";

const NOW = Date.parse("2026-10-20T00:00:00Z");

function intent(
  id: string,
  members: string[],
  tools: Record<string, number> = {},
): IntentGraphIntent {
  return {
    id,
    label: members[0],
    terms: [],
    members,
    support: members.length,
    tools,
    skills: {},
    last_ts: NOW - 1_000,
  };
}

function graph(intents: IntentGraphIntent[]): IntentGraphDocument {
  return { v: 1, built_from_ts: NOW, intents };
}

test("the merged graph's clusters keep their wire ids, members and edges", () => {
  const state = seedState({
    merged: graph([intent("intent_3", ["list open invoices"], { list_invoices: 2 })]),
    bySource: new Map(),
    queryIntents: [],
    now: NOW,
  });
  assert.equal(state.clusters.length, 1);
  const [c] = state.clusters;
  assert.equal(c.id, "intent_3");
  assert.deepEqual(c.members, ["list open invoices"]);
  assert.deepEqual(c.tools, { list_invoices: 2 });
  assert.deepEqual(c.usage, { "tool:list_invoices": 2 });
  assert.equal(state.nextGraphN, 4, "new clusters take ids past the graph's");
});

test("a source's cluster lands on the merged cluster it restates, as that source's slice", () => {
  const state = seedState({
    merged: graph([intent("intent_0", ["list open invoices", "show my open invoices"])]),
    bySource: new Map([["app", graph([intent("intent_7", ["list open invoices"])])]]),
    queryIntents: [],
    now: NOW,
  });
  assert.equal(state.clusters.length, 1);
  assert.equal(state.clusters[0].sources.app.graphId, "intent_7");
  assert.equal(state.nextGraphN, 8);
});

test("a recurring ask links to the cluster that restates it, or seeds its own", () => {
  const state = seedState({
    merged: graph([intent("intent_0", ["cancel my subscription"])]),
    bySource: new Map(),
    queryIntents: [
      { id: "q1", text: "cancel my subscription", memberText: "", occurrences: 4 },
      {
        id: "q2",
        text: "export the quarterly report",
        memberText: "export quarterly report\ndownload the quarterly report",
        occurrences: 2,
      },
      { id: "q3", text: "   ", memberText: "", occurrences: 9 },
    ],
    now: NOW,
  });
  const linked = state.clusters.find((c) => c.queryIntentId === "q1")!;
  assert.equal(linked.id, "intent_0");
  assert.equal(linked.asks, 1 + 4);
  const own = state.clusters.find((c) => c.queryIntentId === "q2")!;
  assert.equal(own.id, "intent_1");
  assert.deepEqual(own.members, [
    "export the quarterly report",
    "export quarterly report",
    "download the quarterly report",
  ]);
  assert.equal(
    state.clusters.some((c) => c.queryIntentId === "q3"),
    false,
    "an ask with no words seeds nothing",
  );
});
