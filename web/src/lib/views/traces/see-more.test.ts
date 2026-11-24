import assert from "node:assert/strict";
import { test } from "node:test";
import { batches, nextCount } from "@/lib/views/traces/see-more";

test("a long list shows ten, then ten more at a time", () => {
  const items = Array.from({ length: 28 }, (_, i) => i);
  assert.deepEqual(
    batches(items, 10).map((batch) => batch.length),
    [10],
  );
  assert.deepEqual(
    batches(items, 20).map((batch) => batch.length),
    [10, 10],
  );
  assert.deepEqual(
    batches(items, 30).map((batch) => batch.length),
    [10, 10, 8],
  );
  assert.equal(nextCount(28, 10), 10);
  assert.equal(nextCount(28, 20), 8);
  assert.equal(nextCount(28, 30), 0);
  assert.equal(nextCount(7, 10), 0);
});
