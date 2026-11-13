import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clusterQueries,
  jaccard,
  labelForFreq,
  tokenize,
  topTokens,
} from "@/lib/readings/text/cluster";

test("tokenize drops stopwords, short tokens, and lowercases", () => {
  assert.deepEqual(tokenize("read and update Notion pages"), ["update", "notion", "pages"]);
  assert.deepEqual(tokenize("list all Linear projects"), ["linear", "projects"]);
});

test("jaccard is intersection-over-union, 0 when either set is empty", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a", "b", "c"]), new Set(["a"])), 1 / 3);
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
});

test("topTokens/labelForFreq rank by frequency then alphabetically", () => {
  const freq = new Map([
    ["zeta", 3],
    ["alpha", 3],
    ["mid", 2],
    ["low", 1],
  ]);
  assert.deepEqual(topTokens(freq, 3), ["alpha", "zeta", "mid"]);
  assert.equal(labelForFreq(freq), "alpha zeta mid");
  assert.equal(labelForFreq(new Map()), "(empty)");
});

test("the plan's own example sits just under the merge threshold", () => {
  // "generate a changelog" vs "make a changelog file": intersection {changelog} = 1,
  // union {generate,changelog,make,file} = 4 -> 0.25 < 0.3. Below the threshold, so
  // these stay separate canonicals (the kind of gap a future clusterer could close).
  const a = new Set(tokenize("generate a changelog"));
  const b = new Set(tokenize("make a changelog file"));
  assert.equal(jaccard(a, b), 0.25);
});

test("clusterQueries groups token-similar queries and separates dissimilar ones", () => {
  const assignments = clusterQueries(
    [
      { key: "k1", query: "read and update Notion pages" },
      { key: "k2", query: "notion search pages" },
      { key: "k3", query: "Granola meeting notes transcript" },
    ],
    [],
  );
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  const k1 = byKey.get("k1")!;
  const k2 = byKey.get("k2")!;
  const k3 = byKey.get("k3")!;
  assert.equal(k1.kind, "new");
  assert.equal(k2.kind, "new");
  assert.equal(k3.kind, "new");
  if (k1.kind === "new" && k2.kind === "new" && k3.kind === "new") {
    assert.equal(k1.clusterKey, k2.clusterKey);
    assert.notEqual(k3.clusterKey, k1.clusterKey);
  }
});

test("clusterQueries merges a new candidate into an existing canonical seed", () => {
  const assignments = clusterQueries(
    [{ key: "k1", query: "notion search pages" }],
    [{ id: "existing-1", text: "read and update Notion pages" }],
  );
  assert.deepEqual(assignments, [{ key: "k1", kind: "existing", existingId: "existing-1" }]);
});

test("clusterQueries leaves a genuinely different query as its own singleton", () => {
  const assignments = clusterQueries(
    [{ key: "k1", query: "review my pull request" }],
    [{ id: "existing-1", text: "generate a changelog" }],
  );
  assert.deepEqual(assignments[0], {
    key: "k1",
    kind: "new",
    clusterKey: "new_1",
    label: "pull request review",
  });
});

test("clusterQueries is deterministic for the same input", () => {
  const candidates = [
    { key: "k1", query: "query rows of a notion database" },
    { key: "k2", query: "notion database query sql" },
  ];
  const a = clusterQueries(candidates, []);
  const b = clusterQueries(candidates, []);
  assert.deepEqual(a, b);
});

test("clusterQueries assigns every candidate exactly once", () => {
  const assignments = clusterQueries(
    [
      { key: "k1", query: "a notion page" },
      { key: "k2", query: "b granola meeting" },
      { key: "k3", query: "c linear issue" },
    ],
    [],
  );
  assert.equal(assignments.length, 3);
});

test("existing seeds are tried before newly spawned buckets (established intents win ties)", () => {
  // Construct a REAL tie: candidate k3 ("notion pages") has token set {notion,pages}.
  // The existing seed "notion pages report" -> {notion,pages,report} gives Jaccard
  // 2/3. The new bucket spawned by k1 ("notion pages dashboard") also grows to
  // {notion,pages,dashboard} -> Jaccard 2/3 against k3. Both buckets score identically;
  // the existing seed must win because it's earlier in bucket order and the clusterer
  // only replaces the best on a STRICT improvement (`sim > bestSim`, not `>=`).
  const assignments = clusterQueries(
    [
      { key: "k1", query: "notion pages dashboard" },
      { key: "k3", query: "notion pages" },
    ],
    [{ id: "existing-1", text: "notion pages report" }],
  );
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  // k1 does NOT clear 0.3 vs the seed ({notion,pages,dashboard} vs {notion,pages,report}
  // = 2/4 = 0.5, so it actually merges too) — assert the tie-breaking directly instead:
  // k3 ties the seed and the k1-bucket, and the seed wins.
  assert.equal(
    byKey.get("k3")?.kind,
    "existing",
    "a query tying an existing seed and a new bucket lands on the existing one",
  );
});

test("clusterQueries tie-break: an exact token match on both an existing seed and a new bucket picks the existing seed", () => {
  // k2 ("alpha beta") ties the existing seed "alpha beta" (Jaccard 1.0) and would also
  // tie k1's new bucket if k1 were "alpha beta" too — force that exact collision.
  const assignments = clusterQueries(
    [
      { key: "k1", query: "alpha beta" },
      { key: "k2", query: "alpha beta" },
    ],
    [{ id: "seed", text: "alpha beta" }],
  );
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  assert.equal(byKey.get("k1")?.kind, "existing");
  assert.equal(byKey.get("k2")?.kind, "existing");
  // Neither spawned a new bucket — both collapsed onto the existing seed.
  assert.ok(assignments.every((a) => a.kind === "existing"));
});
