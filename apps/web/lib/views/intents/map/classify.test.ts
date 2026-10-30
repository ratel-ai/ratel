import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentGraphDocument } from "@/lib/readings/intent-types/wire";
import {
  clusterByMembers,
  createClusterClassifier,
  foldQuery,
} from "@/lib/views/intents/map/classify";

const document: IntentGraphDocument = {
  v: 1,
  built_from_ts: 1_790_000_000_000,
  rev: 4,
  intents: [
    {
      id: "intent_orders",
      label: "find an order",
      terms: ["find", "order"],
      members: ["find an order", "find order 1042", "find the order for jane"],
      support: 12,
      tools: { lookup_order: 12 },
      skills: {},
    },
    {
      id: "intent_tasks",
      label: "create a task",
      terms: ["create", "task"],
      members: ["create a task", "create a task for the release", "create a new task"],
      support: 9,
      tools: { acme_create_task: 9 },
      skills: {},
    },
  ],
};

test("the SDK's own matcher places a search however it is worded, and nothing when it matches no group", () => {
  const classifier = createClusterClassifier(document);
  assert.equal(classifier.method, "matcher");
  assert.equal(classifier.error, null);
  assert.equal(classifier.clusterOf("find an order"), "intent_orders", "a stored phrasing");
  assert.equal(
    classifier.clusterOf("find order 99999"),
    "intent_orders",
    "a wording the group never stored",
  );
  assert.equal(classifier.clusterOf("please create a task for me"), "intent_tasks");
  assert.equal(classifier.clusterOf("what is the weather in paris"), null);
});

test("a graph built on an embedding model is matched by its stored phrasings, folded for case and spacing", () => {
  const embedded = { ...document, model: "text-embedding-3-small" };
  const classifier = createClusterClassifier(embedded);
  assert.equal(classifier.method, "phrasings");
  assert.equal(classifier.clusterOf("  Find   an ORDER "), "intent_orders");
  assert.equal(
    classifier.clusterOf("find order 99999"),
    null,
    "only stored wordings, without the model",
  );
  assert.equal(foldQuery("  Create\tA  task "), "create a task");
  assert.equal(clusterByMembers({ ...document, intents: [] })("find an order"), null);
});

test("a document the SDK cannot read still matches by phrasing, and says why", () => {
  const broken = { ...document, v: 99 } as unknown as IntentGraphDocument;
  const classifier = createClusterClassifier(broken);
  assert.equal(classifier.method, "phrasings");
  assert.ok(classifier.error, "the reason is handed to the caller to report");
  assert.equal(classifier.clusterOf("create a task"), "intent_tasks");
});
