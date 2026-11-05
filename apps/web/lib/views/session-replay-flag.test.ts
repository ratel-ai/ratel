import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionReplayEnabled, sessionReplayLink } from "./session-replay-flag";

test("session replay is off by default", () => {
  assert.equal(sessionReplayEnabled({}), false);
  assert.equal(sessionReplayEnabled({ FF_SESSION_REPLAY: "0" }), false);
  assert.equal(sessionReplayLink("p1", "s 1", {}), null);
});

test("FF_SESSION_REPLAY turns it on and the turn page links the session", () => {
  assert.equal(sessionReplayEnabled({ FF_SESSION_REPLAY: "1" }), true);
  assert.equal(sessionReplayEnabled({ FF_SESSION_REPLAY: "true" }), true);
  assert.equal(
    sessionReplayLink("p1", "s 1", { FF_SESSION_REPLAY: "1" }),
    "/project/p1/sessions/s%201",
  );
});
