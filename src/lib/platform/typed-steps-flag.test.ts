import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import { TYPED_STEPS_FLAG, typedStepsOn } from "@/lib/platform/typed-steps-flag";

const PROJECT = { projectId: "p1" };
const oss = (env: Record<string, string>) => ({ env, edition: "Ratel OSS", port: undefined });

/** A Cloud flags port that answers `answer` and records what it was asked. */
function cloudPort(answer: boolean | Error) {
  const asked: [CoreFlag, FlagSubject][] = [];
  const port = {
    async enabled(flag: CoreFlag, subject: FlagSubject) {
      asked.push([flag, subject]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { asked, port };
}

const cloud = (env: Record<string, string>, port: ReturnType<typeof cloudPort>["port"]) => ({
  env,
  edition: "Ratel Cloud",
  port,
});

test("FF_TYPED_STEPS is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(TYPED_STEPS_FLAG, "FF_TYPED_STEPS");
  assert.ok((CORE_FLAGS as readonly string[]).includes(TYPED_STEPS_FLAG));
});

test("OSS: off with nothing set", async () => {
  assert.equal(await typedStepsOn(PROJECT, oss({})), false);
});

test("OSS: FF_TYPED_STEPS turns typed steps on, and only a true value does", async () => {
  assert.equal(await typedStepsOn(PROJECT, oss({ FF_TYPED_STEPS: "1" })), true);
  assert.equal(await typedStepsOn(PROJECT, oss({ FF_TYPED_STEPS: "true" })), true);
  assert.equal(await typedStepsOn(PROJECT, oss({ FF_TYPED_STEPS: "0" })), false);
  assert.equal(await typedStepsOn(PROJECT, oss({ FF_TYPED_STEPS: "yes" })), false);
});

test("OSS: RATEL_EXPERIMENTAL_FEATURES turns typed steps on; another switch does not", async () => {
  assert.equal(await typedStepsOn(PROJECT, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })), true);
  assert.equal(await typedStepsOn(PROJECT, oss({ FF_TOOL_RUN_INSIGHTS: "1" })), false);
});

test("Cloud: the flags port decides it for the project, on and off", async () => {
  const on = cloudPort(true);
  assert.equal(await typedStepsOn(PROJECT, cloud({}, on.port)), true);
  assert.deepEqual(on.asked, [["FF_TYPED_STEPS", PROJECT]]);

  const off = cloudPort(false);
  assert.equal(await typedStepsOn(PROJECT, cloud({}, off.port)), false);
});

test("Cloud: an FF_TYPED_STEPS value set by the operator comes first", async () => {
  const off = cloudPort(false);
  assert.equal(await typedStepsOn(PROJECT, cloud({ FF_TYPED_STEPS: "1" }, off.port)), true);
  assert.deepEqual(off.asked, []);

  const on = cloudPort(true);
  assert.equal(await typedStepsOn(PROJECT, cloud({ FF_TYPED_STEPS: "0" }, on.port)), false);
});

test("Cloud: a failed decision is off", async () => {
  const failing = cloudPort(new Error("flag service down"));
  assert.equal(await typedStepsOn(PROJECT, cloud({}, failing.port)), false);
});
