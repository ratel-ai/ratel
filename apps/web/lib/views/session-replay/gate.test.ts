import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionReplayEnabledForActor } from "./gate";

const ON = { FF_SESSION_REPLAY: "1" };

test("session replay is off by default, for a person, an API key and a system run", async () => {
  assert.equal(await sessionReplayEnabledForActor("p1", "user_1", undefined, {}), false);
  assert.equal(await sessionReplayEnabledForActor("p1", "project:p1", undefined, {}), false);
  assert.equal(
    await sessionReplayEnabledForActor("p1", "system:what-if", undefined, {
      FF_SESSION_REPLAY: "0",
    }),
    false,
  );
});

test("FF_SESSION_REPLAY turns it on for everyone on the deployment, with no database read", async () => {
  assert.equal(await sessionReplayEnabledForActor("p1", "user_1", undefined, ON), true);
  assert.equal(await sessionReplayEnabledForActor("p1", "project:p1", undefined, ON), true);
  assert.equal(await sessionReplayEnabledForActor("p1", "system:what-if", undefined, ON), true);
});
