import assert from "node:assert/strict";
import { test } from "node:test";
import { readDrafts, writeDrafts } from "@/components/console/catalog/draft-storage";

// Node has no session storage, which is also what a browser with storage
// blocked looks like: drafts must still survive within the page view.

test("drafts survive within a page view even without session storage", () => {
  writeDrafts("project-a", new Map([["tool:ripgrep", "search the code"]]));
  assert.equal(readDrafts("project-a").get("tool:ripgrep"), "search the code");
  assert.equal(
    readDrafts("project-a"),
    readDrafts("project-a"),
    "the same object until it changes",
  );
});

test("drafts are kept per project and cleared by writing an empty set", () => {
  writeDrafts("project-b", new Map([["skill:s1", "draft"]]));
  assert.equal(readDrafts("project-c").size, 0);
  writeDrafts("project-b", new Map());
  assert.equal(readDrafts("project-b").size, 0);
});
