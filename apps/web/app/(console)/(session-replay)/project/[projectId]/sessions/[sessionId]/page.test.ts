import assert from "node:assert/strict";
import { test } from "node:test";
import SessionReplayPage from "./page";

test("the session replay page is a 404 while FF_SESSION_REPLAY is off", async () => {
  delete process.env.FF_SESSION_REPLAY;
  // A database that is never reached: the flag answers first.
  process.env.DATABASE_URL = "postgres://unreachable.invalid:1/none";
  await assert.rejects(
    SessionReplayPage({ params: Promise.resolve({ projectId: "p1", sessionId: "s1" }) }),
    (err: { digest?: string }) => String(err.digest).includes("404"),
  );
});
