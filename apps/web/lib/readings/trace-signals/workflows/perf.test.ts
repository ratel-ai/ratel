import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
import { rng, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

/**
 * Performance smoke: 20k turns over a 150-tool catalog mine in under 2 s.
 * Six planted workflows cover 60% of turns; the rest call 2 to 5 random
 * tools; a helper runs in 55% of all turns. The planted cores must come back.
 */

const TOOLS = Array.from({ length: 150 }, (_, i) => `tool_${i.toString().padStart(3, "0")}`);
const PLANTED = [
  ["tool_001", "tool_002", "tool_003"],
  ["tool_010", "tool_011", "tool_012", "tool_013"],
  ["tool_020", "tool_021", "tool_022", "tool_023", "tool_024"],
  ["tool_030", "tool_031", "tool_032"],
  ["tool_040", "tool_041", "tool_042", "tool_043"],
  ["tool_050", "tool_051", "tool_052"],
];
const HELPER = "tool_149";

function world(n: number): SignalTurn[] {
  const next = rng(42);
  const pick = () => TOOLS[Math.floor(next() * (TOOLS.length - 1))]!;
  return Array.from({ length: n }, () => {
    const planted = next() < 0.6 ? PLANTED[Math.floor(next() * PLANTED.length)] : undefined;
    const body = planted ?? Array.from({ length: 2 + Math.floor(next() * 4) }, pick);
    return wfTurn(next() < 0.55 ? [HELPER, ...body] : body);
  });
}

test("20k turns x 150 tools mine in under 2 s and find every planted workflow", () => {
  const turns = world(20_000);
  const started = performance.now();
  const result = mineWorkflows(turns);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `mined in ${Math.round(elapsed)} ms`);
  const cores = new Set(result.workflows.map((w) => w.coreTools.join(",")));
  for (const planted of PLANTED)
    assert.ok(cores.has([...planted].sort().join(",")), `found ${planted.join(",")}`);
  assert.ok(
    result.workflows.every((w) => !w.coreTools.includes(HELPER)),
    "the helper is never core",
  );
  assert.equal(result.truncated, false);
});

test("the signal run places and reads those 20k runs, task by task, in under 3 s", async () => {
  const { createWorkflowCollector } = await import(
    "@/lib/readings/trace-signals/signals/workflow-run"
  );
  const turns = world(20_000);
  const started = performance.now();
  const collector = createWorkflowCollector();
  for (const turn of turns) collector.collect(turn);
  const { stored, placement } = collector.finish([]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3_000, `collected, placed and read in ${Math.round(elapsed)} ms`);
  assert.equal(placement.size, 20_000);
  assert.ok(stored.items.every((item) => item.reading && item.reading.runs === item.runs));
});
