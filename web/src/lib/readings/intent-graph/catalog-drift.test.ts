import assert from "node:assert/strict";
import { test } from "node:test";
import { goneTools, missingCapabilityKeys } from "@/lib/readings/intent-graph/catalog-drift";
import { graphToolIds, pruneGoneTools } from "@/lib/readings/intent-graph/prune-gone-tools";
import type { IntentGraphDocument, IntentGraphIntent } from "@/lib/readings/intent-types/wire";

test("a project with no tool catalog has no gone tools, whatever the graph lifts", () => {
  const drift = goneTools(["Bash", "Read", "mcp__x__y"], new Set(), new Set());
  assert.equal(drift.hasCatalog, false);
  assert.deepEqual([...drift.gone], []);
});

test("a tool is gone only when the catalog dropped it and the agent stopped calling it", () => {
  const drift = goneTools(
    ["listed", "dropped_but_called", "dropped_and_idle"],
    new Set(["listed", "other"]),
    new Set(["dropped_but_called"]),
  );
  assert.equal(drift.hasCatalog, true);
  assert.deepEqual([...drift.gone], ["dropped_and_idle"]);
});

test("missing keys keep the detail's skills and take tools from the gone rule", () => {
  const keys = missingCapabilityKeys(new Set(["tool:Bash", "tool:old", "skill:retired"]), {
    hasCatalog: true,
    gone: new Set(["old"]),
  });
  assert.deepEqual([...keys].sort(), ["skill:retired", "tool:old"]);
});

function intent(
  id: string,
  tools: Record<string, number>,
  over: Partial<IntentGraphIntent> = {},
): IntentGraphIntent {
  return { id, label: id, terms: [], members: [id], support: 1, tools, skills: {}, ...over };
}

function graph(intents: IntentGraphIntent[]): IntentGraphDocument {
  return { v: 1, built_from_ts: 1, rev: 3, intents, custom: "kept" };
}

test("pruning drops gone tools' edges and the ask groups left lifting nothing", () => {
  const before = graph([
    intent("mixed", { keep: 2, gone: 1 }, { surfaced_tools: { gone: 4, keep: 1 } }),
    intent("only_gone", { gone: 3 }),
    intent("skill_only", { gone: 1 }, { skills: { "write-report": 2 } }),
    intent("untouched", { keep: 5 }),
    intent("no_edges", {}),
  ]);
  const result = pruneGoneTools(before, new Set(["gone"]));

  assert.equal(result.edgesPruned, 3);
  assert.equal(result.intentsDropped, 1);
  assert.deepEqual(
    result.graph.intents.map((it) => it.id),
    ["mixed", "skill_only", "untouched", "no_edges"],
  );
  assert.deepEqual(result.graph.intents[0]!.tools, { keep: 2 });
  assert.deepEqual(result.graph.intents[0]!.surfaced_tools, { keep: 1 });
  assert.deepEqual(
    result.graph.intents[1]!.skills,
    { "write-report": 2 },
    "a skill still lifts the group",
  );
  assert.equal(result.graph.intents[2], before.intents[3], "an untouched group is the same object");
  assert.equal(result.graph.custom, "kept", "fields the store does not know survive");
  assert.equal(before.intents.length, 5, "the input is not mutated");
});

test("pruning with nothing gone hands back the same graph", () => {
  const before = graph([intent("a", { keep: 1 })]);
  const result = pruneGoneTools(before, new Set(["absent"]));
  assert.equal(result.graph, before);
  assert.equal(result.edgesPruned, 0);
});

test("a graph's tool ids include tools it only surfaced", () => {
  const ids = graphToolIds(graph([intent("a", { x: 1 }, { surfaced_tools: { y: 2 } })]));
  assert.deepEqual([...ids].sort(), ["x", "y"]);
});
