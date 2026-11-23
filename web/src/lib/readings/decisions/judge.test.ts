import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bm25Order,
  type CorpusEntry,
  identityCriteria,
  identityFingerprint,
  JUDGE_CONFIDENT,
  JUDGE_MIN_CONFIDENCE,
  judgeOptions,
  verdictFrom,
} from "./judge";

const entry = (id: string, searchable: string, extra: Partial<CorpusEntry> = {}): CorpusEntry => ({
  entryId: id,
  name: id,
  searchable,
  source: "runtime",
  matchesAgentDescription: true,
  tags: [],
  ...extra,
});

test("the identity fingerprint ignores order and operator overrides, and moves with the tools", () => {
  const a = entry("a", "alpha", { description: "Alpha", runtimeSearchable: "find alpha" });
  const b = entry("b", "beta", { description: "Beta" });
  const same = identityFingerprint([b, a]);
  assert.equal(identityFingerprint([a, b]), same);
  assert.equal(
    identityFingerprint([{ ...a, searchable: "OVERRIDE" }, b]),
    same,
    "an override is not identity",
  );
  assert.notEqual(identityFingerprint([{ ...a, description: "Alpha 2" }, b]), same);
  assert.notEqual(identityFingerprint([a]), same);
  assert.equal(same.length, 32);
});

test("identity criteria read the agent description and the SDK's text, never the override", () => {
  const overridden = entry("a", "OVERRIDE", {
    description: "Alpha does things",
    runtimeSearchable: "find alpha",
  });
  assert.deepEqual(identityCriteria(overridden), {
    does: "Alpha does things",
    searchable: "find alpha",
  });
  assert.deepEqual(identityCriteria(entry("b", "beta text")), {
    does: "beta text",
    searchable: "beta text",
  });
  const long = identityCriteria(entry("c", "x".repeat(700)));
  assert.equal(long.does.length, 600, "clipped to the field cap, ellipsis included");
});

test("options are the whole corpus when it fits, else the shortlist then BM25, under both caps", () => {
  const corpus = Array.from({ length: 5 }, (_, i) => entry(`t${i}`, `tool ${i}`));
  const bm25 = (_query: string, depth: number) => ["t4", "t3", "t2", "t1", "t0"].slice(0, depth);
  assert.deepEqual(
    judgeOptions({ query: "q", shortlist: ["t1"] }, corpus, bm25).map((e) => e.entryId),
    ["t0", "t1", "t2", "t3", "t4"],
  );
  const narrowed = judgeOptions({ query: "q", shortlist: ["t1"] }, corpus, bm25, 3);
  assert.deepEqual(
    narrowed.map((e) => e.entryId),
    ["t1", "t4", "t3"],
    "the shortlist first, then BM25's order",
  );
  const byChars = judgeOptions({ query: "q", shortlist: [] }, corpus, bm25, 150, 20);
  assert.deepEqual(
    byChars.map((e) => e.entryId),
    ["t4"],
    "the character cap stops the list",
  );
});

test("verdicts abstain below the threshold, keep the leaning, and mark the confident ones", () => {
  assert.deepEqual(verdictFrom("1", undefined), { id: "1", entryId: "", confident: false });
  assert.deepEqual(
    verdictFrom("1", { choice: "a", confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } }),
    {
      id: "1",
      entryId: "",
      confident: false,
      confidence: 0.5,
      runnerUp: "a",
    },
  );
  assert.deepEqual(
    verdictFrom("1", { choice: "a", confidence: 0.85, probabilities: { a: 0.85, b: 0.15 } }),
    {
      id: "1",
      entryId: "a",
      confident: false,
      confidence: 0.85,
      runnerUp: "b",
    },
  );
  const sure = verdictFrom("1", { choice: "a", confidence: 0.95, probabilities: { a: 0.95 } });
  assert.deepEqual(sure, { id: "1", entryId: "a", confident: true, confidence: 0.95 });
  assert.ok(JUDGE_MIN_CONFIDENCE < JUDGE_CONFIDENT);
});

test("the BM25 order ranks by the query and skips entries with no text to index", () => {
  const order = bm25Order([
    entry("tasks", "create and assign tasks on a board"),
    entry("docs", "read a document page"),
    entry("blank", "   "),
  ]);
  assert.deepEqual(order("assign a task", 2), ["tasks"], "only entries sharing a term come back");
  assert.deepEqual(order("read the document", 1), ["docs"]);
  assert.deepEqual(order("task document", 5).sort(), ["docs", "tasks"]);
  assert.ok(!order("anything blank", 10).includes("blank"));
});
