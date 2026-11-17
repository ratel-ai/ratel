import assert from "node:assert/strict";
import { test } from "node:test";
import { decideReprocessFlags } from "./reprocess-flags";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION = { id: "22222222-2222-4222-8222-222222222222", slug: "acme" };

/** Owned: the switch decides, and the decision names where it came from. */

test("the reply capture follows FF_SESSION_REPLAY", async () => {
  const on = await decideReprocessFlags(PROJECT_ID, ORGANIZATION, { FF_SESSION_REPLAY: "1" });
  assert.deepEqual(on.flags, { captureReply: true });
  assert.deepEqual(on.decisions, [
    { flag: "FF_SESSION_REPLAY", enabled: true, source: "deployment switch" },
  ]);

  const off = await decideReprocessFlags(PROJECT_ID, ORGANIZATION, {});
  assert.deepEqual(off.flags, { captureReply: false });
});
