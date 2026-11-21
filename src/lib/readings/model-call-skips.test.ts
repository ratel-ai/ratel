import assert from "node:assert/strict";
import { test } from "node:test";
import { setModelCallSink } from "@/lib/platform/model-call";
import { type NameCandidate, nameEngineClusters } from "@/lib/readings/intent-engine/names-job";
import { labelProjectWorkflows } from "@/lib/readings/trace-signals/workflows/label-job";

/**
 * A model call skipped for want of a key is still a `model_call` line, as upstream writes it
 * (`skipped_no_key`, paid by Ratel, no duration): the intent names and the workflow labels.
 */
function capture(t: { after: (fn: () => void) => void }) {
  const lines: Record<string, unknown>[] = [];
  const restore = setModelCallSink({ info: (fields) => lines.push(fields), warn: () => {} });
  t.after(restore);
  return lines;
}

const CANDIDATE: NameCandidate = {
  id: "c1",
  level: 0,
  phrases: ["refund an order"],
  hash: "h1",
  weight: 3,
  named: false,
};

const noDb = { transaction: async () => assert.fail("no write without a model") } as never;

test("intent names without a model: one skipped_no_key line, none with nothing to name", async (t) => {
  const lines = capture(t);
  const deps = { model: "claude-haiku-5-5", complete: null, maxNames: 10 };
  assert.equal((await nameEngineClusters("p1", noDb, deps, [CANDIDATE])).skipped, "no_model");
  await nameEngineClusters("p1", noDb, deps, []);
  await nameEngineClusters("p1", noDb, { ...deps, maxNames: 0 }, [CANDIDATE]);
  assert.deepEqual(
    lines.map((line) => [line.feature, line.outcome, line.payer, line.provider, line.duration_ms]),
    [["intent_names", "skipped_no_key", "ratel", "anthropic", 0]],
  );
});

test("workflow labels without a model: one skipped_no_key line, none with no workflow", async (t) => {
  const lines = capture(t);
  const workflow = { id: "w1" } as never;
  const deps = {
    model: "claude-sonnet-5-5",
    complete: null,
    decide: null,
    loadLabelHashes: async () => assert.fail("nothing to compare without a model"),
  };
  const result = await labelProjectWorkflows("p1", {
    ...deps,
    loadLatestWorkflows: async () => [workflow],
  });
  assert.equal(result.skipped, "no_model");
  await labelProjectWorkflows("p1", { ...deps, loadLatestWorkflows: async () => [] });
  assert.deepEqual(
    lines.map((line) => [line.feature, line.outcome, line.payer, line.provider, line.duration_ms]),
    [["workflow_label", "skipped_no_key", "ratel", "anthropic", 0]],
  );
});
