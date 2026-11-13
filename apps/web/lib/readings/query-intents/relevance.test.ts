import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRelevanceIndex,
  identifierTokens,
  looksLikeIdentifier,
  stem,
  tokenizeForRelevance,
} from "@/lib/readings/query-intents/relevance";

// The five-skill staging catalog every false positive in the investigation came
// from, so the cases below are the ones observed, not invented.
const CATALOG = [
  {
    id: "deploy-service",
    text: "deploy-service\nDeploy a service to production and report the rollout status.",
  },
  { id: "explain-error", text: "explain-error\nError tool." },
  {
    id: "review-pull-request",
    text: "review-pull-request\nReview a pull request: summarize the diff, flag risky changes, and suggest concrete improvements.",
  },
  {
    id: "search-codebase",
    text: "search-codebase\nSearch the codebase for symbols, usages, or patterns and summarize where they occur.\nsearch",
  },
  {
    id: "write-unit-tests",
    text: "write-unit-tests\nGenerate unit tests for a function or module, covering edge cases and error paths.",
  },
];

test("tokenizer splits hyphenated names, drops function words, and stems", () => {
  assert.deepEqual(tokenizeForRelevance("Search-Codebase for the usages"), [
    "search",
    "codebase",
    "usage",
  ]);
  assert.deepEqual(tokenizeForRelevance("I want to know if there are commits"), ["commit"]);
});

test("stemming folds common inflections without mangling short words", () => {
  assert.equal(stem("commits"), "commit");
  assert.equal(stem("refunded"), "refund");
  assert.equal(stem("deploying"), "deploy");
  assert.equal(stem("changes"), "change");
  assert.equal(stem("usages"), "usage");
  assert.equal(stem("patches"), "patch");
  assert.equal(stem("deployment"), "deploy");
  assert.equal(stem("deployments"), "deploy");
  assert.equal(stem("status"), "status");
  assert.equal(stem("is"), "is");
});

test("a phrase that restates the skill scores relevance 1", () => {
  const index = buildRelevanceIndex(CATALOG);
  const [top] = index.search("search the codebase for symbols and usages");
  assert.equal(top.id, "search-codebase");
  assert.equal(top.relevance, 1, "every query term matched → full IDF mass → clamped to 1");
});

test("one incidental shared word on a multi-word ask scores low", () => {
  const index = buildRelevanceIndex(CATALOG);
  // Observed: raw BM25 called this COVERED by search-codebase on the word "codebase".
  const [top] = index.search(
    "know if there are any uncommitted changes or not pushed commits in the codebase",
  );
  assert.equal(top.id, "search-codebase");
  assert.ok(top.relevance < 0.35, `expected a low share, got ${top.relevance}`);
  assert.ok(top.relevance > 0, "the shared word still registers");
});

test("a phrase sharing nothing with any skill has no hits", () => {
  const index = buildRelevanceIndex(CATALOG);
  assert.deepEqual(index.search("get a refund for being charged twice last month"), []);
});

test("unmatched query terms count against relevance", () => {
  const index = buildRelevanceIndex([{ id: "plans", text: "list subscription plans" }]);
  const [top] = index.search("cancel my subscription");
  assert.equal(top.id, "plans");
  // "cancel" is unseen (max idf) and "subscription" matched: well under half the mass.
  assert.ok(top.relevance < 0.5, `expected under 0.5, got ${top.relevance}`);
});

test("relevance is clamped to [0, 1] even when tf saturation pushes the raw score past the mass", () => {
  const index = buildRelevanceIndex([
    { id: "a", text: "refund refund refund refund" },
    { id: "b", text: "something entirely different about deployments" },
  ]);
  const [top] = index.search("refund");
  assert.equal(top.id, "a");
  assert.ok(top.score > index.idf("refund"), "raw BM25 exceeds a single idf here");
  assert.equal(top.relevance, 1);
});

test("an empty query or an empty index yields no hits", () => {
  const index = buildRelevanceIndex(CATALOG);
  assert.deepEqual(index.search("the and of"), []);
  assert.deepEqual(buildRelevanceIndex([]).search("deploy"), []);
});

test("hits are best-first and honour topK", () => {
  const index = buildRelevanceIndex(CATALOG);
  const hits = index.search("summarize the error in the codebase", 2);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].relevance >= hits[1].relevance);
});

test("a custom tokenizer is applied to documents and queries alike", () => {
  const synonyms = new Map([["subscription", "plan"]]);
  const tokenize = (t: string) => tokenizeForRelevance(t).map((x) => synonyms.get(x) ?? x);
  const plain = buildRelevanceIndex([{ id: "p", text: "cancel their plan" }]);
  const mapped = buildRelevanceIndex([{ id: "p", text: "cancel their plan" }], { tokenize });
  assert.ok(
    (plain.search("cancel their subscription")[0]?.relevance ?? 0) < 0.6,
    "no synonym: partial match",
  );
  assert.equal(
    mapped.search("cancel their subscription")[0]?.relevance,
    1,
    "synonym map: full match",
  );
});

test("a code identifier in the ask is capped, so the operation words decide coverage", () => {
  const index = buildRelevanceIndex(CATALOG);
  const withId = index.search(
    "find all usages of the deprecated fetchWithTimeout function in the codebase",
  )[0];
  assert.equal(withId?.id, "search-codebase");
  const plain = index.search("find all usages of the deprecated function in the codebase")[0];
  assert.ok(
    withId!.relevance >= plain!.relevance - 0.15,
    `identifier should not dominate: ${withId!.relevance} vs ${plain!.relevance}`,
  );
  assert.ok(
    looksLikeIdentifier("fetchWithTimeout") &&
      looksLikeIdentifier("max_tokens") &&
      looksLikeIdentifier("v2"),
  );
  assert.ok(!looksLikeIdentifier("deploy") && !looksLikeIdentifier("Deploy"));
});

test("search and relevanceBetween agree for an indexed document (one scoring path)", () => {
  const docs = [
    { id: "deploy", text: "deploy the application to production safely" },
    { id: "tests", text: "write unit tests for a module" },
    { id: "refund", text: "refund a customer order and notify billing" },
  ];
  const index = buildRelevanceIndex(docs);
  for (const query of ["deploy my app to production", "please refund the order", "write tests"]) {
    for (const hit of index.search(query)) {
      const doc = docs.find((d) => d.id === hit.id)!;
      assert.equal(index.relevanceBetween(query, doc.text), hit.relevance, `${query} → ${hit.id}`);
    }
  }
});

test("identifierTokens ignores sentence punctuation at a word's edges", () => {
  assert.deepEqual([...identifierTokens("refund their order.")], []);
  assert.deepEqual([...identifierTokens("Does it retry?")], []);
  assert.ok(
    identifierTokens("call fetch.retry.").size > 0,
    "an interior dot still marks an identifier",
  );
  assert.ok(identifierTokens("see v2.").has("v2"));
  assert.deepEqual([...identifierTokens("...")], []);
});
