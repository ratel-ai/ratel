import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTimeLabel } from "./adaptive-view";

test("relativeTimeLabel picks the coarsest useful unit", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  assert.equal(relativeTimeLabel(null, now), "never");
  assert.equal(relativeTimeLabel(ago(30_000), now), "just now");
  assert.equal(relativeTimeLabel(ago(5 * 60_000), now), "5m ago");
  assert.equal(relativeTimeLabel(ago(3 * 3_600_000), now), "3h ago");
  assert.equal(relativeTimeLabel(ago(12 * 86_400_000), now), "12d ago");
  assert.equal(relativeTimeLabel(ago(90 * 86_400_000), now), "3mo ago");
  assert.equal(relativeTimeLabel(ago(800 * 86_400_000), now), "2y ago");
});
