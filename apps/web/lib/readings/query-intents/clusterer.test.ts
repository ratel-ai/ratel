import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ClusterCandidate,
  type ClusterCanonical,
  JaccardClusterer,
} from "@/lib/readings/query-intents/clusterer";

const clusterer = new JaccardClusterer();

test("resolves a candidate into an existing canonical when Jaccard overlap clears the threshold", async () => {
  const existing: ClusterCanonical[] = [
    {
      id: "ex1",
      normalizedText: "read and update notion pages",
      text: "read and update Notion pages",
    },
  ];
  const out = await clusterer.cluster(
    [{ key: "notion search pages", text: "notion search pages" }],
    existing,
  );
  // Jaccard({notion,search,pages},{read,update,notion,pages}) = 2/5 = 0.4 >= 0.3.
  assert.deepEqual(out.get("notion search pages"), {
    normalizedText: "read and update notion pages",
    canonicalText: "read and update Notion pages", // the existing canonical's display text wins
  });
});

test("two same-run near-duplicates collapse into one shared canonical", async () => {
  const candidates: ClusterCandidate[] = [
    { key: "read and update notion pages", text: "read and update Notion pages" },
    { key: "notion search pages", text: "notion search pages" },
  ];
  const out = await clusterer.cluster(candidates, []);
  const a = out.get("read and update notion pages")!;
  const b = out.get("notion search pages")!;
  assert.deepEqual(a, b, "both candidates resolve to the same canonical");
});

test("a lexically-distinct candidate stands as its own canonical (never dropped)", async () => {
  const out = await clusterer.cluster(
    [{ key: "review my pull request", text: "review my pull request" }],
    [],
  );
  assert.deepEqual(out.get("review my pull request"), {
    normalizedText: "review my pull request",
    canonicalText: "review my pull request",
  });
});

test("empty candidates yields an empty map", async () => {
  const out = await clusterer.cluster([], [{ id: "x", normalizedText: "y", text: "y" }]);
  assert.equal(out.size, 0);
});
