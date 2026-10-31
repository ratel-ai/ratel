import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ifMatchMatches } from "@/lib/catalog/wire";
import {
  cloudGraphSource,
  cloudSourceGraphKey,
  expireIntentGraphClusters,
  type IntentGraphDocument,
  intentGraphContentHash,
  intentGraphEtag,
  isCloudGraphKey,
  MAX_INTENT_GRAPH_CLUSTERS,
  parseIntentGraphPutBody,
  validateIntentGraph,
} from "@/lib/readings/intent-types/wire";

/**
 * The protocol's intent-graph conformance vectors, vendored with the catalog v2
 * vectors. Every `valid` doc must validate and every `invalid` doc must be
 * rejected; that is the contract shared with the in-process learner.
 */
type GraphVectors = {
  graph: {
    valid: { name: string; doc: unknown }[];
    invalid: { name: string; doc: unknown }[];
  };
};

const vectors: GraphVectors = JSON.parse(
  readFileSync(
    new URL("../../catalog/__fixtures__/catalog-v2-vectors.json", import.meta.url),
    "utf8",
  ),
);

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}

for (const v of vectors.graph.valid) {
  test(`graph fixture validates: ${v.name}`, () => {
    const result = validateIntentGraph(v.doc);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.strictEqual(result.graph, v.doc, "must return the same reference");
  });
}

for (const v of vectors.graph.invalid) {
  test(`graph fixture is rejected: ${v.name}`, () => {
    const result = validateIntentGraph(v.doc);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.details.length > 0);
      const members = collectStrings(
        (v.doc as { intents?: { members?: unknown }[] }).intents?.map((i) => i.members),
      );
      for (const detail of result.details) {
        for (const member of members) {
          assert.ok(!detail.includes(member), `detail leaks a member: ${detail}`);
        }
      }
    }
  });
}

const base: IntentGraphDocument = {
  v: 1,
  built_from_ts: 1753000000000,
  rev: 3,
  intents: [
    {
      id: "intent_0",
      label: "is the build green",
      terms: ["build"],
      members: ["why is the build broken"],
      support: 2,
      tools: { gh_run_list: 2 },
      skills: {},
    },
  ],
};

test("validation rejects a non-object and a cluster count over the cap", () => {
  assert.equal(validateIntentGraph("nope").ok, false);
  const many: IntentGraphDocument = {
    ...base,
    intents: Array.from({ length: MAX_INTENT_GRAPH_CLUSTERS + 1 }, (_, i) => ({
      ...base.intents[0],
      id: `intent_${i}`,
    })),
  };
  const result = validateIntentGraph(many);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.details.some((d) => d.includes("exceeds")));
});

test("content hash ignores rev but not content, model, or unknown fields", () => {
  const h = intentGraphContentHash(base);
  assert.equal(intentGraphContentHash({ ...base, rev: 99 }), h);
  const { rev: _rev, ...withoutRev } = base;
  assert.equal(intentGraphContentHash(withoutRev as IntentGraphDocument), h);
  assert.notEqual(intentGraphContentHash({ ...base, built_from_ts: 1 }), h);
  assert.notEqual(intentGraphContentHash({ ...base, model: "bge" }), h);
  assert.notEqual(intentGraphContentHash({ ...base, cluster_policy: { similarity: 0.7 } }), h);
  assert.notEqual(
    intentGraphContentHash({ ...base, intents: [{ ...base.intents[0], support: 3 }] }),
    h,
  );
});

test("content hash is stable across key order", () => {
  const reordered = JSON.parse(
    JSON.stringify({
      intents: base.intents.map((i) => ({
        skills: i.skills,
        tools: i.tools,
        support: i.support,
        members: i.members,
        terms: i.terms,
        label: i.label,
        id: i.id,
      })),
      built_from_ts: base.built_from_ts,
      v: 1,
    }),
  ) as IntentGraphDocument;
  assert.equal(intentGraphContentHash(reordered), intentGraphContentHash(base));
  assert.equal(intentGraphEtag("abc"), '"abc"');
});

test("put body parsing requires source_id and a valid graph", () => {
  const ok = parseIntentGraphPutBody({ source_id: " worker-a ", graph: base });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.sourceId, "worker-a");
    assert.strictEqual(ok.graph, base);
  }
  const noSource = parseIntentGraphPutBody({ graph: base });
  assert.equal(noSource.ok, false);
  if (!noSource.ok) assert.ok(noSource.details.some((d) => d.startsWith("source_id")));
  const longSource = parseIntentGraphPutBody({ source_id: "x".repeat(513), graph: base });
  assert.equal(longSource.ok, false);
  const badGraph = parseIntentGraphPutBody({ source_id: "a", graph: { v: 2 } });
  assert.equal(badGraph.ok, false);
  if (!badGraph.ok) assert.ok(badGraph.details.some((d) => d.includes("schema version")));
  assert.equal(parseIntentGraphPutBody(null).ok, false);
  assert.equal(parseIntentGraphPutBody([]).ok, false);
});

test("ifMatchMatches implements the strong comparison", () => {
  const current = '"abc"';
  assert.equal(ifMatchMatches(null, current), true, "absent header passes");
  assert.equal(ifMatchMatches(undefined, current), true);
  assert.equal(ifMatchMatches("*", current), true);
  assert.equal(ifMatchMatches('"abc"', current), true);
  assert.equal(ifMatchMatches('"zzz", "abc"', current), true);
  assert.equal(ifMatchMatches('"zzz"', current), false);
  assert.equal(ifMatchMatches('W/"abc"', current), false, "weak tag never matches");
  assert.equal(ifMatchMatches("", current), false, "empty header is a failed precondition");
});

test("surfaced counts are typed and validated: non-negative integers per capability", () => {
  const intent = {
    id: "intent_0",
    label: "l",
    terms: [],
    members: ["why is the build broken"],
    support: 3,
    tools: { gh_run_list: 2 },
    skills: {},
  };
  const doc = (over: Record<string, unknown>) => ({
    v: 1,
    built_from_ts: 1,
    intents: [{ ...intent, ...over }],
  });

  const ok = validateIntentGraph(doc({ surfaced_tools: { gh_run_list: 5, docker_build: 0 } }));
  assert.equal(ok.ok, true);
  if (ok.ok)
    assert.deepEqual(ok.graph.intents[0].surfaced_tools, { gh_run_list: 5, docker_build: 0 });

  const bad = validateIntentGraph(doc({ surfaced_tools: { gh_run_list: -1 } }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.details[0], /surfaced_tools: count must be a non-negative integer/);

  const notObject = validateIntentGraph(doc({ surfaced_skills: [1, 2] }));
  assert.equal(notObject.ok, false);
  if (!notObject.ok) assert.match(notObject.details[0], /surfaced_skills: must be an object/);

  const absent = validateIntentGraph(doc({}));
  assert.equal(absent.ok, true);
});

test("cloud keys: the merged graph and every per-source graph belong to Ratel", () => {
  assert.equal(cloudSourceGraphKey("acme-bm25"), "cloud/acme-bm25");
  assert.equal(cloudGraphSource("cloud/acme-bm25"), "acme-bm25");
  assert.equal(cloudGraphSource("cloud"), null);
  assert.equal(cloudGraphSource("acme-bm25"), null);
  assert.ok(isCloudGraphKey("cloud") && isCloudGraphKey("cloud/x"));
  assert.ok(!isCloudGraphKey("cloudy") && !isCloudGraphKey("acme-bm25"));
});

test("expiring clusters drops those last observed before the cutoff and keeps the rest untouched", () => {
  const intent = (id: string, last_ts?: number) => ({
    id,
    label: id,
    terms: [],
    members: [`ask ${id}`],
    support: 1,
    ...(last_ts === undefined ? {} : { last_ts }),
    tools: {},
    skills: {},
  });
  const graph: IntentGraphDocument = {
    v: 1,
    built_from_ts: 1_000,
    rev: 7,
    intents: [intent("old", 99), intent("edge", 100), intent("new", 500), intent("undated")],
  };
  const { graph: kept, expired } = expireIntentGraphClusters(graph, 100);
  assert.equal(expired, 1);
  assert.deepEqual(
    kept.intents.map((i) => i.id),
    ["edge", "new", "undated"],
  );
  assert.equal(kept.rev, 7, "the rev is the store's to assign");
  assert.equal(JSON.stringify(kept).includes("ask old"), false, "the member text is gone");
  // Nothing stale: the same object back, so the caller can skip the write.
  assert.equal(expireIntentGraphClusters(kept, 100).graph, kept);
});
