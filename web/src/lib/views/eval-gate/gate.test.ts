import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import {
  EVAL_GATE_OFF_ERROR,
  evalGateEnabled,
  evalGateEnabledFor,
  evalGateEnabledForActor,
  evalGateEnabledForRun,
} from "./gate";

const ORGANIZATION = { id: "org-1" } as Parameters<typeof evalGateEnabledFor>[0];
const ON = resolveConfig({ override: { flags: { evalGate: true } } });

test("the eval gate is off by default, for a person, an API key and a queued run", async () => {
  assert.equal(evalGateEnabled(resolveConfig()), false);
  assert.equal(evalGateEnabled(resolveConfig({ override: { flags: { evalGate: false } } })), false);
  assert.equal(await evalGateEnabledFor(ORGANIZATION, resolveConfig()), false);
  assert.equal(
    await evalGateEnabledForActor("p1", "project:p1", undefined, resolveConfig()),
    false,
  );
  assert.equal(
    await evalGateEnabledForRun({ projectId: "p1", requestedBy: null }, undefined, resolveConfig()),
    false,
  );
  assert.match(EVAL_GATE_OFF_ERROR, /eval gate is off/);
});

test("evalGate turns it on for everyone on the deployment, with no database read", async () => {
  assert.equal(evalGateEnabled(ON), true);
  assert.equal(await evalGateEnabledFor(ORGANIZATION, ON), true);
  assert.equal(await evalGateEnabledForActor("p1", "user-1", undefined, ON), true);
  assert.equal(
    await evalGateEnabledForRun({ projectId: "p1", requestedBy: "user-1" }, undefined, ON),
    true,
  );
});

test("the eval pages' layout asks the gate for its project, as the switch says", async () => {
  const { evalGateEnabledForProject } = await import("./gate");
  assert.equal(await evalGateEnabledForProject("p1", resolveConfig()), false);
  assert.equal(await evalGateEnabledForProject("p1", ON), true);
});
