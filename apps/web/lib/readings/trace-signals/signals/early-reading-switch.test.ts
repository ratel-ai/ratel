import assert from "node:assert/strict";
import { test } from "node:test";
import { QUICK_FIRST_READING_FLAG, quickFirstReadingEnabled } from "./early-reading";

/**
 * The quick first reading is a deployment switch here (upstream's is a per-project flag): off
 * unless `FF_QUICK_FIRST_READING` is set, whatever the project or organization.
 */
test("the quick first reading follows FF_QUICK_FIRST_READING and is off by default", async () => {
  assert.equal(QUICK_FIRST_READING_FLAG, "FF_QUICK_FIRST_READING");
  assert.equal(await quickFirstReadingEnabled("p-1", null, {}), false);
  assert.equal(await quickFirstReadingEnabled("p-1", null, { FF_QUICK_FIRST_READING: "1" }), true);
  assert.equal(
    await quickFirstReadingEnabled("p-1", { id: "org-1" }, { FF_QUICK_FIRST_READING: "0" }),
    false,
  );
});
