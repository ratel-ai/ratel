import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentGraph } from "@ratel-ai/sdk";
import { trimIntentGraph } from "@/lib/readings/intent-graph/bound";
import {
  type IntentGraphDocument,
  type IntentGraphIntent,
  validateIntentGraph,
} from "@/lib/readings/intent-types/wire";

const NOW = 1_790_000_000_000;

function cluster(
  id: string,
  support: number,
  lastTs: number,
  members: string[] = [`ask for ${id}`],
): IntentGraphIntent {
  return {
    id,
    label: members[0]!,
    terms: [],
    members,
    support,
    tools: { log_hours: support },
    skills: {},
    last_ts: lastTs,
  };
}

function graph(intents: IntentGraphIntent[]): IntentGraphDocument {
  return { v: 1, built_from_ts: NOW, rev: 3, intents };
}

const bytes = (doc: IntentGraphDocument) => Buffer.byteLength(JSON.stringify(doc), "utf8");

test("a graph inside both caps is returned as is", () => {
  const doc = graph([cluster("intent_1", 1, NOW), cluster("intent_2", 2, NOW)]);
  const result = trimIntentGraph(doc, { maxClusters: 2, maxBytes: bytes(doc) });
  assert.equal(result.graph, doc);
  assert.equal(result.dropped, 0);
});

test("over the cluster cap, the strongest clusters stay: most support, then most recent, then the learner's id", () => {
  const doc = graph([
    cluster("intent_1", 1, NOW - 5_000),
    cluster("intent_2", 4, NOW - 9_000),
    cluster("intent_3", 1, NOW),
    cluster("intent_4", 1, NOW - 5_000),
    cluster("intent_10", 1, NOW - 5_000),
  ]);
  const result = trimIntentGraph(doc, { maxClusters: 3, maxBytes: 4_000_000 });
  assert.equal(result.dropped, 2);
  // intent_2 by support, intent_3 by recency, intent_1 before intent_4 and intent_10 by id; original order kept.
  assert.deepEqual(
    result.graph.intents.map((it) => it.id),
    ["intent_1", "intent_2", "intent_3"],
  );
  assert.equal(result.graph.rev, 3);
  assert.equal(result.graph.built_from_ts, NOW);
});

test("over the byte cap, the strongest clusters that fit stay and the document fits exactly as JSON.stringify writes it", () => {
  const long = (id: string) =>
    Array.from({ length: 20 }, (_, i) => `ask ${i} for ${id} about the site report`);
  const doc = graph([
    cluster("intent_1", 3, NOW, long("intent_1")),
    cluster("intent_2", 2, NOW, long("intent_2")),
    cluster("intent_3", 1, NOW, long("intent_3")),
  ]);
  const twoBytes = bytes(graph(doc.intents.slice(0, 2)));
  for (const maxBytes of [twoBytes, twoBytes + 1, bytes(doc) - 1]) {
    const result = trimIntentGraph(doc, { maxClusters: 5_000, maxBytes });
    assert.deepEqual(
      result.graph.intents.map((it) => it.id),
      ["intent_1", "intent_2"],
      `at ${maxBytes} bytes`,
    );
    assert.ok(bytes(result.graph) <= maxBytes);
  }
  const one = trimIntentGraph(doc, { maxClusters: 5_000, maxBytes: twoBytes - 1 });
  assert.deepEqual(
    one.graph.intents.map((it) => it.id),
    ["intent_1"],
  );
});

test("a trimmed graph validates on Ratel and loads in the SDK", () => {
  const doc = graph(
    Array.from({ length: 12 }, (_, i) => cluster(`intent_${i}`, (i % 3) + 1, NOW - i)),
  );
  const { graph: out, dropped } = trimIntentGraph(doc, { maxClusters: 5, maxBytes: 4_000_000 });
  assert.equal(dropped, 7);
  const validation = validateIntentGraph(out, { maxClusters: 5 });
  assert.ok(validation.ok, validation.ok ? "" : validation.details.join("; "));
  assert.equal(IntentGraph.fromJson(JSON.stringify(out)).clusterCount, 5);
});
