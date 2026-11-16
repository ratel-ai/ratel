import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { composition } from "@/lib/composition/ports";
import {
  isRestrictedBySupportSession,
  SUPPORT_SESSION_RESTRICTED_MESSAGE,
} from "@/lib/platform/support-session";

const actingAs = composition.session.actingAs;
afterEach(() => {
  composition.session.actingAs = actingAs;
});

test("no support session restricts nothing", async () => {
  composition.session.actingAs = async () => null;
  assert.equal(await isRestrictedBySupportSession(), false);
});

test("any support session restricts, read-only or not", async () => {
  for (const readOnly of [true, false]) {
    composition.session.actingAs = async () => ({
      kind: "organization",
      targetId: "org",
      readOnly,
    });
    assert.equal(await isRestrictedBySupportSession(), true, `readOnly=${readOnly}`);
  }
  assert.match(SUPPORT_SESSION_RESTRICTED_MESSAGE, /support session/i);
});
