import assert from "node:assert/strict";
import { test } from "node:test";
import { settle } from "./crafter-types";

test("settle passes an answer through and folds a throw into a failure", async () => {
  assert.deepEqual(await settle(async () => ({ ok: true })), { ok: true });
  assert.deepEqual(await settle(async () => ({ ok: false, message: "No." })), {
    ok: false,
    message: "No.",
  });
  const thrown = await settle(async () => {
    throw new Error("offline");
  });
  assert.equal(thrown.ok, false);
});
