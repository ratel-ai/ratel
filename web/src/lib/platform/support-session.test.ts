import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { composition } from "@/lib/composition/ports";
import {
  afterOutsideSupportSession,
  isRestrictedBySupportSession,
  SUPPORT_SESSION_RESTRICTED_MESSAGE,
  supportSessionActingAs,
} from "@/lib/platform/support-session";

const actingAs = composition.session.actingAs;
const present = composition.session.supportSessionPresent;
afterEach(() => {
  composition.session.actingAs = actingAs;
  composition.session.supportSessionPresent = present;
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

test("analytics run after the response outside a support session, and never inside one", async () => {
  const scheduled: (() => unknown)[] = [];
  const schedule = (task: () => unknown) => {
    scheduled.push(task);
  };
  let ran = 0;
  const task = () => {
    ran += 1;
  };

  composition.session.actingAs = async () => null;
  await afterOutsideSupportSession(task, schedule);
  assert.equal(scheduled.length, 1, "deferred, not run inline");
  assert.equal(ran, 0);
  scheduled[0]?.();
  assert.equal(ran, 1);

  composition.session.actingAs = async () => ({ kind: "user", targetId: "u", readOnly: true });
  await afterOutsideSupportSession(task, schedule);
  assert.equal(scheduled.length, 1, "nothing scheduled in a support session");
});

test("a support-session marker the edition can't resolve still restricts, as upstream's cookie check", async () => {
  composition.session.actingAs = async () => null;
  composition.session.supportSessionPresent = async () => true;
  assert.equal(await isRestrictedBySupportSession(), true);
  assert.deepEqual(await supportSessionActingAs(), {
    kind: "organization",
    targetId: "",
    readOnly: true,
  });
});

test("with no marker and no session, writes are allowed; a resolved session is passed through", async () => {
  composition.session.actingAs = async () => null;
  composition.session.supportSessionPresent = async () => false;
  assert.equal(await isRestrictedBySupportSession(), false);
  assert.equal(await supportSessionActingAs(), null);
  const session = { kind: "user" as const, targetId: "u1", readOnly: false };
  composition.session.actingAs = async () => session;
  assert.equal(await supportSessionActingAs(), session);
});

test("an edition without the marker check behaves as before", async () => {
  composition.session.actingAs = async () => null;
  composition.session.supportSessionPresent = undefined;
  assert.equal(await isRestrictedBySupportSession(), false);
  assert.equal(await supportSessionActingAs(), null);
});
