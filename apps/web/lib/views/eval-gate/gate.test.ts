import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVAL_GATE_OFF_ERROR,
  evalGateEnabled,
  evalGateEnabledFor,
  evalGateEnabledForActor,
  evalGateEnabledForRun,
} from "./gate";

const ORGANIZATION = { id: "org-1" } as Parameters<typeof evalGateEnabledFor>[0];
const ON = { FF_EVAL_GATE: "1" };

test("the eval gate is off by default, for a person, an API key and a queued run", async () => {
  assert.equal(evalGateEnabled({}), false);
  assert.equal(evalGateEnabled({ FF_EVAL_GATE: "0" }), false);
  assert.equal(await evalGateEnabledFor(ORGANIZATION, {}), false);
  assert.equal(await evalGateEnabledForActor("p1", "project:p1", undefined, {}), false);
  assert.equal(
    await evalGateEnabledForRun({ projectId: "p1", requestedBy: null }, undefined, {}),
    false,
  );
  assert.match(EVAL_GATE_OFF_ERROR, /eval gate is off/);
});

test("FF_EVAL_GATE turns it on for everyone on the deployment, with no database read", async () => {
  assert.equal(evalGateEnabled(ON), true);
  assert.equal(await evalGateEnabledFor(ORGANIZATION, ON), true);
  assert.equal(await evalGateEnabledForActor("p1", "user-1", undefined, ON), true);
  assert.equal(
    await evalGateEnabledForRun({ projectId: "p1", requestedBy: "user-1" }, undefined, ON),
    true,
  );
});
