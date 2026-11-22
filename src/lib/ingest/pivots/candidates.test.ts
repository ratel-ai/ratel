import assert from "node:assert/strict";
import { test } from "node:test";
import { type RootSample, rankCandidates } from "./candidates";

/** RC-882: rank the attribute keys of recent root spans as pivot candidates (pure, no I/O). */

function samples(
  count: number,
  attributes: (index: number) => Record<string, unknown>,
): RootSample[] {
  return Array.from({ length: count }, (_, index) => ({
    traceId: `t${index}`,
    attributes: attributes(index),
  }));
}

test("ranks by coverage, then by distinct values", () => {
  const ranked = rankCandidates(
    samples(10, (index) => ({
      "tenant.id": `org-${index % 3}`,
      ...(index < 5 ? { "customer.tier": index % 2 ? "gold" : "free" } : {}),
      "app.region": index % 2 ? "eu" : "us",
    })),
  );
  assert.deepEqual(
    ranked.map((candidate) => [candidate.key, candidate.coverage, candidate.distinct]),
    [
      ["tenant.id", 1, 3],
      ["app.region", 1, 2],
      ["customer.tier", 0.5, 2],
    ],
  );
});

test("excludes a key whose value is different on each trace", () => {
  const ranked = rankCandidates(
    samples(20, (index) => ({ "request.id": `r${index}`, "user.id": `u${index % 4}` })),
  );
  assert.deepEqual(
    ranked.map((candidate) => candidate.key),
    ["user.id"],
  );
});

test("excludes a key with one value only", () => {
  const ranked = rankCandidates(
    samples(10, (index) => ({ "service.tier": "prod", "user.id": `u${index % 2}` })),
  );
  assert.deepEqual(
    ranked.map((candidate) => candidate.key),
    ["user.id"],
  );
});

test("excludes keys Ratel owns: gen_ai content, ratel.*, trace and span ids, long values, nested values, keys that cannot be added", () => {
  const ranked = rankCandidates(
    samples(10, (index) => ({
      "gen_ai.prompt": `p${index % 2}`,
      "ratel.turn": `x${index % 2}`,
      "parent.trace_id": `a${index % 2}`,
      "span.id": `s${index % 2}`,
      "long.text": `${"x".repeat(300)}${index % 2}`,
      nested: { a: index % 2 },
      "has space": `h${index % 2}`,
      "tenant.id": `o${index % 2}`,
    })),
  );
  assert.deepEqual(
    ranked.map((candidate) => candidate.key),
    ["tenant.id"],
  );
});

test("marks keys that match a preset, including a gen_ai preset key", () => {
  const ranked = rankCandidates(
    samples(10, (index) => ({
      "tenant.id": `o${index % 3}`,
      "gen_ai.conversation.id": `c${index % 2}`,
      "customer.tier": index % 2 ? "a" : "b",
    })),
  );
  assert.deepEqual(
    ranked.map((candidate) => [candidate.key, candidate.presetId]),
    [
      ["tenant.id", "client"],
      ["customer.tier", null],
      ["gen_ai.conversation.id", "session"],
    ],
  );
});

test("counts a trace once, reads numbers and booleans, skips empty strings, and drops configured keys", () => {
  const ranked = rankCandidates(
    [
      { traceId: "t1", attributes: { "plan.seats": 5, "beta.user": true, empty: "" } },
      { traceId: "t1", attributes: { "plan.seats": 5, "beta.user": true } },
      { traceId: "t2", attributes: { "plan.seats": 10, "beta.user": false, empty: "" } },
      { traceId: "t3", attributes: { "plan.seats": 5, "beta.user": true, "tenant.id": "a" } },
      { traceId: "t4", attributes: { "plan.seats": 10, "beta.user": false, "tenant.id": "b" } },
    ],
    { configuredKeys: ["beta.user"] },
  );
  assert.deepEqual(
    ranked.map((candidate) => [candidate.key, candidate.traces, candidate.distinct]),
    [["plan.seats", 4, 2]],
  );
});

test("keeps at most the limit, and an empty sample gives nothing", () => {
  const ranked = rankCandidates(
    samples(10, (index) =>
      Object.fromEntries(Array.from({ length: 30 }, (_, key) => [`k${key}`, `v${index % 2}`])),
    ),
    { limit: 5 },
  );
  assert.equal(ranked.length, 5);
  assert.deepEqual(rankCandidates([]), []);
});
