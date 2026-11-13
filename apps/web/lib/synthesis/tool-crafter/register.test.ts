import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRegistrations, jobHandlers } from "@/lib/composition/registry";
import { exploreSeams } from "@/lib/readings/tool-explorer/job";
import { toolExplorerRegistration } from "@/lib/readings/tool-explorer/register";
import { exploreSeamFills, fillExploreSeams, toolCrafterRegistration } from "./register";

test("registers the craft_tools job and no drain step", () => {
  assert.deepEqual(Object.keys(toolCrafterRegistration.jobs ?? {}), ["craft_tools"]);
  assert.equal(toolCrafterRegistration.drainSteps, undefined);
});

test("loading the registration fills the explorer job's crafter seam", () => {
  assert.equal(exploreSeams.enqueueCraft, exploreSeamFills.enqueueCraft);
  const seams: typeof exploreSeams = {};
  fillExploreSeams(seams);
  assert.deepEqual(seams, exploreSeamFills);
});

test("the core order lists the crafter after the explorer it reads, and the registry knows its kind", () => {
  const core = collectRegistrations(undefined, []);
  const explorer = core.indexOf(toolExplorerRegistration);
  const crafter = core.indexOf(toolCrafterRegistration);
  assert.ok(explorer >= 0, "the explorer is a core registration");
  assert.ok(crafter > explorer, "the crafter follows the explorer");
  assert.equal(typeof jobHandlers(core).craft_tools, "function");
});
