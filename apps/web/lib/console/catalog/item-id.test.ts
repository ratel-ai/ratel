import assert from "node:assert/strict";
import { test } from "node:test";
import { itemKey, parseItemKey, withItemParam, withQueryParam, withQueryParams } from "./item-id";

test("an item id is its kind and its key", () => {
  assert.equal(itemKey("tool", "ripgrep"), "tool:ripgrep");
  assert.equal(
    itemKey("skill", "2b8509e1-2015-4d86-895d-78c4943ff643"),
    "skill:2b8509e1-2015-4d86-895d-78c4943ff643",
  );
});

test("parsing reads the kind and keeps everything after the first colon", () => {
  assert.deepEqual(parseItemKey("tool:ripgrep"), { kind: "tool", id: "ripgrep" });
  assert.deepEqual(parseItemKey("skill:abc"), { kind: "skill", id: "abc" });
  assert.deepEqual(parseItemKey("tool:github__create_issue"), {
    kind: "tool",
    id: "github__create_issue",
  });
  assert.deepEqual(
    parseItemKey("tool:mcp:server:tool"),
    { kind: "tool", id: "mcp:server:tool" },
    "colons inside a name survive",
  );
});

test("anything malformed is no selection", () => {
  for (const value of [
    null,
    undefined,
    "",
    "ripgrep",
    "fact:x",
    "tools:ripgrep",
    "tool:",
    "tool:   ",
    ":ripgrep",
    "tool:a\nb",
    `tool:${"x".repeat(513)}`,
  ]) {
    assert.equal(parseItemKey(value), null, String(value));
  }
});

test("selecting writes a readable item param and keeps the rest of the query", () => {
  assert.equal(withItemParam("", "tool:ripgrep"), "?item=tool:ripgrep");
  assert.equal(withItemParam("?q=kan", "tool:kanban_whoami"), "?q=kan&item=tool:kanban_whoami");
  assert.equal(withItemParam("q=kan&item=tool:a", "skill:b"), "?q=kan&item=skill:b");
  assert.equal(withItemParam("?q=kan&item=tool:a", null), "?q=kan");
  assert.equal(withItemParam("?item=tool:a", null), "");
  assert.equal(
    withItemParam("", "tool:a b&c"),
    "?item=tool:a+b%26c",
    "anything unsafe is still encoded",
  );
  assert.deepEqual(
    parseItemKey(new URLSearchParams("item=tool:a+b%26c").get("item")),
    { kind: "tool", id: "a b&c" },
    "and it round-trips through the URL",
  );
});

test("any query param can be set or cleared the same way", () => {
  assert.equal(withQueryParam("?item=tool:a", "q", "kan"), "?item=tool:a&q=kan");
  assert.equal(withQueryParam("?item=tool:a&q=kan", "q", ""), "?item=tool:a");
  assert.equal(
    withQueryParams("?q=kan&page=3&peek=a", { sort: "calls", dir: "asc", page: null }),
    "?q=kan&peek=a&sort=calls&dir=asc",
    "a sort keeps the search and the open row, and starts from the first page",
  );
});
