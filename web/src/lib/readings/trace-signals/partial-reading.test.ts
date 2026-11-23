import assert from "node:assert/strict";
import { test } from "node:test";
import { type PartialFacts, partialReading } from "@/lib/readings/trace-signals/partial-reading";

const FACTS: PartialFacts = {
  runs: 10,
  completedRuns: 9,
  calls: 40,
  failedCalls: 2,
  modelCalls: 25,
  tokens: 50_000,
  p95RunMs: 24_000,
  steps: [
    { name: "files.read", calls: 8, failed: 1, leafCalls: 8, p95Ms: 120 },
    { name: "agent_run.turn", calls: 3, failed: 0, leafCalls: 0, p95Ms: 9_000 },
    { name: "item.list", calls: 8, failed: 0, leafCalls: 5, p95Ms: 80 },
    { name: "mixed", calls: 4, failed: 0, leafCalls: 2, p95Ms: null },
  ],
  models: [
    { model: "gemini-lite", calls: 5, tokens: 1_000 },
    { model: "gemini-flash", calls: 20, tokens: 49_000 },
  ],
};

test("reads the run tiles from the facts", () => {
  const reading = partialReading(FACTS, 30);
  assert.equal(reading.windowDays, 30);
  assert.equal(reading.runs, 10);
  assert.equal(reading.completedShare, 0.9);
  assert.equal(reading.failedCalls, 2);
  assert.equal(reading.calls, 40);
  assert.equal(reading.roundTripsPerRun, 2.5);
  assert.equal(reading.p95RunMs, 24_000);
  assert.equal(reading.tokensPerRun, 5_000);
});

test("a step is a likely tool when at least half its calls have no child span", () => {
  const byName = new Map(partialReading(FACTS, 30).steps.map((s) => [s.name, s.likelyTool]));
  assert.equal(byName.get("files.read"), true);
  assert.equal(byName.get("item.list"), true);
  assert.equal(byName.get("mixed"), true);
  assert.equal(byName.get("agent_run.turn"), false, "a wrapper that holds other steps");
});

test("steps and models are listed most called first, ties by name", () => {
  const reading = partialReading(FACTS, 30);
  assert.deepEqual(
    reading.steps.map((s) => s.name),
    ["files.read", "item.list", "mixed", "agent_run.turn"],
  );
  assert.deepEqual(
    reading.models.map((m) => m.model),
    ["gemini-flash", "gemini-lite"],
  );
});

test("an empty window has no shares, no averages and no rows", () => {
  const reading = partialReading(
    {
      runs: 0,
      completedRuns: 0,
      calls: 0,
      failedCalls: 0,
      modelCalls: 0,
      tokens: null,
      p95RunMs: null,
      steps: [],
      models: [],
    },
    7,
  );
  assert.equal(reading.runs, 0);
  assert.equal(reading.completedShare, null);
  assert.equal(reading.roundTripsPerRun, null);
  assert.equal(reading.tokensPerRun, null);
  assert.deepEqual(reading.steps, []);
});

test("runs without token counts have no tokens per run", () => {
  assert.equal(partialReading({ ...FACTS, tokens: null }, 30).tokensPerRun, null);
});
