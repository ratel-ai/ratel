import assert from "node:assert/strict";
import { test } from "node:test";
import { traceFiltersEnabledForActor, traceViewsV3EnabledForActor } from "./views-flag";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("a failed flag read is off and reported, never thrown: the traces pages stay up", async () => {
  const reported: string[] = [];
  const enabled = await traceViewsV3EnabledForActor(PROJECT_ID, "user_1", {
    read: async () => {
      throw new Error("db down");
    },
    report: (message) => reported.push(message),
  });

  assert.equal(enabled, false);
  assert.deepEqual(reported, ["trace views flag read failed"]);
});

test("a project id that is no UUID is off without a read", async () => {
  let reads = 0;
  const enabled = await traceViewsV3EnabledForActor("not-a-uuid", "user_1", {
    read: async () => ((reads += 1), true),
    report: () => {},
  });

  assert.deepEqual([enabled, reads], [false, 0]);
});

test("the flag's answer passes through", async () => {
  assert.equal(
    await traceViewsV3EnabledForActor(PROJECT_ID, "user_1", {
      read: async () => true,
      report: () => {},
    }),
    true,
  );
});

test("the trace filters flag: a failed read is off and reported, a bad project id is off without a read", async () => {
  const reported: string[] = [];
  const failing = {
    read: async () => Promise.reject(new Error("db down")),
    report: (message: string) => reported.push(message),
  };
  assert.equal(await traceFiltersEnabledForActor(PROJECT_ID, "user_1", failing), false);
  assert.deepEqual(reported, ["trace filters flag read failed"]);
  assert.equal(
    await traceFiltersEnabledForActor("not-a-uuid", "user_1", {
      read: async () => true,
      report: () => {},
    }),
    false,
  );
  assert.equal(
    await traceFiltersEnabledForActor(PROJECT_ID, "user_1", {
      read: async () => true,
      report: () => {},
    }),
    true,
  );
});
