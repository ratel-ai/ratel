import assert from "node:assert/strict";
import { test } from "node:test";
import { createComparisonPageCache } from "@/lib/synthesis/experiments/comparison-cache";

test("cached pages are served until they go stale", () => {
  const cache = createComparisonPageCache<string>({
    ttlMs: 1_000,
    maxEntries: 4,
  });
  cache.set("page-1", "rows", 0);

  assert.equal(cache.get("page-1", 999), "rows");
  assert.equal(cache.get("page-1", 1_000), null);
  assert.equal(cache.size(), 0, "stale entries are dropped on read");
});

test("the least recently used page is evicted once the cache is full", () => {
  const cache = createComparisonPageCache<string>({
    ttlMs: 60_000,
    maxEntries: 2,
  });
  cache.set("page-1", "one", 0);
  cache.set("page-2", "two", 0);
  // Reading page-1 makes page-2 the least recently used entry.
  assert.equal(cache.get("page-1", 1), "one");
  cache.set("page-3", "three", 2);

  assert.equal(cache.get("page-2", 3), null);
  assert.equal(cache.get("page-1", 3), "one");
  assert.equal(cache.get("page-3", 3), "three");
  assert.equal(cache.size(), 2);
});

test("re-storing a key refreshes its age instead of duplicating it", () => {
  const cache = createComparisonPageCache<string>({
    ttlMs: 1_000,
    maxEntries: 4,
  });
  cache.set("page-1", "old", 0);
  cache.set("page-1", "new", 900);

  assert.equal(cache.size(), 1);
  assert.equal(cache.get("page-1", 1_500), "new");
});

test("concurrent page loads for one key share the same in-flight request", async () => {
  const cache = createComparisonPageCache<string>({
    ttlMs: 1_000,
    maxEntries: 4,
  });
  let resolve!: (value: string) => void;
  let calls = 0;
  const loader = () => {
    calls += 1;
    return new Promise<string>((done) => {
      resolve = done;
    });
  };

  const first = cache.load("page-1", 10, loader);
  const second = cache.load("page-1", 10, loader);
  assert.equal(calls, 1);

  resolve("rows");
  assert.equal(await first, "rows");
  assert.equal(await second, "rows");
  assert.equal(cache.get("page-1", 11), "rows");
});

test("clear drops every cached page", () => {
  const cache = createComparisonPageCache<string>({
    ttlMs: 1_000,
    maxEntries: 4,
  });
  cache.set("page-1", "rows", 0);
  cache.clear();

  assert.equal(cache.get("page-1", 0), null);
  assert.equal(cache.size(), 0);
});
