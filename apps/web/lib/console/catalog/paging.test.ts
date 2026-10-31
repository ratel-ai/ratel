import assert from "node:assert/strict";
import { test } from "node:test";
import { pageLabel, pageWindow, parsePage } from "./paging";

test("a page number from the URL is a positive whole number, else the first page", () => {
  assert.equal(parsePage("3"), 3);
  for (const value of [null, undefined, "", "0", "-2", "1.5", "two", "1e400"])
    assert.equal(parsePage(value), 1, String(value));
});

test("a window covers its page and never runs past the last one", () => {
  assert.deepEqual(
    pageWindow(97, 1),
    { page: 1, pageCount: 1, offset: 0, end: 97 },
    "the demo fits on one page",
  );
  assert.deepEqual(pageWindow(1234, 2), { page: 2, pageCount: 13, offset: 100, end: 200 });
  assert.deepEqual(pageWindow(1234, 13), { page: 13, pageCount: 13, offset: 1200, end: 1234 });
  assert.deepEqual(
    pageWindow(1234, 99),
    { page: 13, pageCount: 13, offset: 1200, end: 1234 },
    "a stale link lands on the last page",
  );
  assert.deepEqual(
    pageWindow(0, 4),
    { page: 1, pageCount: 1, offset: 0, end: 0 },
    "an empty list is one empty page",
  );
  assert.deepEqual(pageWindow(30, 2, 25), { page: 2, pageCount: 2, offset: 25, end: 30 });
});

test("the pager names the page and how many there are", () => {
  assert.equal(pageLabel(pageWindow(1234, 2)), "Page 2 of 13");
  assert.equal(pageLabel(pageWindow(250_000, 1)), "Page 1 of 2,500");
  assert.equal(
    pageLabel(pageWindow(1234, 99)),
    "Page 13 of 13",
    "a stale link names the page it landed on",
  );
});
