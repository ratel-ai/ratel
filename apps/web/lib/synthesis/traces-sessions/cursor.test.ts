import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSessionsCursor, encodeSessionsCursor } from "./cursor";

/** RC-313: the Sessions list pages by an opaque cursor; a bad one reads as the first page. */

test("a cursor reads back as the activity and id it was made from", () => {
  const cursor = { at: "2026-11-03T09:00:00.123456Z", id: "session|with-a-bar" };
  assert.deepEqual(decodeSessionsCursor(encodeSessionsCursor(cursor)), cursor);
});

test("a missing or malformed cursor reads as the first page", () => {
  assert.equal(decodeSessionsCursor(null), null);
  assert.equal(decodeSessionsCursor(""), null);
  assert.equal(decodeSessionsCursor("not a cursor"), null);
  assert.equal(
    decodeSessionsCursor(encodeSessionsCursor({ at: "2026-11-03", id: "s1" })),
    null,
    "the time must be full UTC with microseconds",
  );
  assert.equal(
    decodeSessionsCursor(encodeSessionsCursor({ at: "2026-11-03T09:00:00.123456Z", id: "" })),
    null,
    "the id must be there",
  );
});
