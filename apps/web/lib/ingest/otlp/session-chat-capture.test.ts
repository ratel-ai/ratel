import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionChatCaptureEnabled } from "@/lib/ingest/otlp/session-chat-capture";
import { sessionReplayEnabled } from "@/lib/views/session-replay-flag";

const organization = { id: "org_capture", slug: "acme" };

test("ingest capture follows FF_SESSION_REPLAY, the switch the session page reads", async () => {
  for (const env of [{ FF_SESSION_REPLAY: "1" }, { FF_SESSION_REPLAY: "0" }, {}]) {
    assert.equal(
      await sessionChatCaptureEnabled("proj_capture", organization, env),
      sessionReplayEnabled(env),
    );
  }
});

test("ingest capture is on when the switch is on", async () => {
  assert.equal(
    await sessionChatCaptureEnabled("proj_capture_on", organization, { FF_SESSION_REPLAY: "1" }),
    true,
  );
});

test("ingest capture is off by default", async () => {
  assert.equal(await sessionChatCaptureEnabled("proj_capture_off", organization, {}), false);
});

test("the switch is the deployment's: the organization does not change the answer", async () => {
  const env = { FF_SESSION_REPLAY: "1" };
  assert.equal(await sessionChatCaptureEnabled("proj_capture_none", null, env), true);
});
