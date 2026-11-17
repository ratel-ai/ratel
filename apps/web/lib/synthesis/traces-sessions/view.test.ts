import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionsFilter, withSessionsFilter } from "./view";

/** RC-313: the Sessions tab's filter lives in the URL. */

test("the filter reads from ?show=: All or Failed, no To check", () => {
  assert.equal(parseSessionsFilter("failed"), "failed");
  assert.equal(parseSessionsFilter("to_check"), "all");
  assert.equal(
    parseSessionsFilter(["failed", "all"]),
    "failed",
    "a repeated value reads as its first",
  );
  assert.equal(parseSessionsFilter(null), "all");
  assert.equal(parseSessionsFilter([]), "all");
});

test("changing the filter drops the open row and keeps the rest, the timeframe too", () => {
  assert.equal(
    withSessionsFilter("?window=24h&peek=session:x&columns=tools", "failed"),
    "?window=24h&columns=tools&show=failed",
  );
  assert.equal(withSessionsFilter("?show=failed", "all"), "");
});
