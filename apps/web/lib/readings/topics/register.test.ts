import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { computeSeamFills, fillComputeSeams, topicsRegistration } from "./register";

test("registers the topics job and no drain step", () => {
  assert.deepEqual(Object.keys(topicsRegistration.jobs ?? {}), ["assign_topics"]);
  assert.equal(topicsRegistration.drainSteps, undefined);
});

test("loading the registration fills the compute job's topics seam, and leaves the explorer's open", () => {
  assert.equal(computeSeams.enqueueTopics, computeSeamFills.enqueueTopics);
  assert.equal(computeSeams.enqueueExplore, undefined);
  const seams: typeof computeSeams = {};
  fillComputeSeams(seams);
  assert.deepEqual(seams, computeSeamFills);
});
