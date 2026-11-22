import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { exploreSeams } from "./job";
import { computeSeamFills, fillComputeSeams, toolExplorerRegistration } from "./register";

test("registers the explore_tool_usage job and no drain step", () => {
  assert.deepEqual(Object.keys(toolExplorerRegistration.jobs ?? {}), ["explore_tool_usage"]);
  assert.equal(toolExplorerRegistration.drainSteps, undefined);
});

test("loading the registration fills the compute job's explorer seam", () => {
  assert.equal(computeSeams.enqueueExplore, computeSeamFills.enqueueExplore);
  const seams: typeof computeSeams = {};
  fillComputeSeams(seams);
  assert.deepEqual(seams, computeSeamFills);
});

test("the explorer's own crafter seam stays empty: the crafter's registration fills it", () => {
  assert.equal(exploreSeams.enqueueCraft, undefined);
});
