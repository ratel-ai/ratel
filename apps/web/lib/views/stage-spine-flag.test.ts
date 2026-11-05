import assert from "node:assert/strict";
import { test } from "node:test";
import { stageSpineEnabled } from "./stage-spine-flag";

test("the stage spine is off by default", () => {
  assert.equal(stageSpineEnabled({}), false);
  assert.equal(stageSpineEnabled({ FF_STAGE_SPINE: "0" }), false);
  assert.equal(stageSpineEnabled({ FF_STAGE_SPINE: "nope" }), false);
});

test("FF_STAGE_SPINE turns it on", () => {
  assert.equal(stageSpineEnabled({ FF_STAGE_SPINE: "1" }), true);
  assert.equal(stageSpineEnabled({ FF_STAGE_SPINE: "true" }), true);
});
