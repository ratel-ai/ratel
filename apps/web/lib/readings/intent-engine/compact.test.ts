import assert from "node:assert/strict";
import { test } from "node:test";
import { compactEngine } from "@/lib/readings/intent-engine/compact";
import type { EngineCluster } from "@/lib/readings/intent-types/engine-types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T00:00:00Z");

function cluster(p: Partial<EngineCluster> & Pick<EngineCluster, "id" | "members">): EngineCluster {
  return {
    uuid: `u-${p.id}`,
    label: p.members[0],
    terms: [],
    servedMembers: [],
    support: 0,
    asks: 1,
    first_ts: NOW - 30 * DAY,
    last_ts: NOW - 10 * DAY,
    tools: {},
    skills: {},
    usage: {},
    sources: {},
    queryIntentId: null,
    ...p,
  };
}

test("edge lane: settled fragments that agree on edges and wording merge, Ratel fields too", () => {
  const big = cluster({
    id: "intent_1",
    members: ["search tasks about billing"],
    servedMembers: ["search tasks about billing"],
    support: 4,
    asks: 6,
    tools: { search_tasks: 4 },
    usage: { "tool:search_tasks": 4 },
    queryIntentId: "q1",
  });
  const small = cluster({
    id: "intent_2",
    members: ["search tasks for onboarding"],
    servedMembers: ["search tasks for onboarding"],
    support: 1,
    asks: 2,
    tools: { search_tasks: 1 },
    usage: { "tool:search_tasks": 1 },
    queryIntentId: "q2",
  });
  const out = compactEngine([big, small], NOW);
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.merges, [
    { absorbedUuid: "u-intent_2", survivorUuid: "u-intent_1", absorbedQueryIntentId: "q2" },
  ]);
  const [kept] = out.clusters;
  assert.equal(kept.asks, 8);
  assert.equal(kept.support, 5);
  assert.deepEqual(kept.servedMembers, [
    "search tasks about billing",
    "search tasks for onboarding",
  ]);
  assert.equal(kept.queryIntentId, "q1");
});

test("wording lane: an unanswered fragment joins the cluster it restates, once settled", () => {
  const answered = cluster({ id: "intent_1", members: ["cancel my subscription plan"], asks: 5 });
  const fragment = cluster({ id: "intent_2", members: ["cancel the subscription plan"], asks: 1 });
  const fresh = cluster({
    id: "intent_3",
    members: ["cancel subscription plan please"],
    asks: 1,
    last_ts: NOW - DAY,
  });
  const out = compactEngine([answered, fragment, fresh], NOW);
  assert.deepEqual(out.merges, [
    { absorbedUuid: "u-intent_2", survivorUuid: "u-intent_1", absorbedQueryIntentId: null },
  ]);
  assert.equal(out.clusters.find((c) => c.id === "intent_1")!.asks, 6);
  assert.ok(
    out.clusters.some((c) => c.id === "intent_3"),
    "a fragment still learning stays",
  );
});

test("wording lane: loose wording does not merge", () => {
  const out = compactEngine(
    [
      cluster({ id: "intent_1", members: ["cancel my subscription"], asks: 5 }),
      cluster({ id: "intent_2", members: ["upgrade my subscription"], asks: 1 }),
    ],
    NOW,
  );
  assert.equal(out.merges.length, 0);
});
