import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DRAFTS_PER_KIND } from "./contract";
import {
  clearDraft,
  countDrafts,
  draftsStorageKey,
  emptyDraftsByKind,
  parseStoredDrafts,
  setDraftField,
} from "./drafts";

test("draftsStorageKey scopes storage per project", () => {
  assert.notEqual(draftsStorageKey("a"), draftsStorageKey("b"));
  assert.match(draftsStorageKey("a"), /\.a$/);
});

test("parseStoredDrafts round-trips a valid payload", () => {
  const drafts = {
    skill: { "review-pull-request": { description: "x", tags: ["git"] } },
    tool: { github_api: { description: "y" } },
  };
  assert.deepEqual(parseStoredDrafts(JSON.stringify(drafts)), drafts);
});

test("parseStoredDrafts never throws on hostile or absent storage", () => {
  // This input is user-writable, so every one of these has to degrade to empty
  // rather than take down the bench on mount.
  for (const raw of [null, "", "not json", "[]", '"a string"', "42", "null"]) {
    assert.deepEqual(parseStoredDrafts(raw), emptyDraftsByKind());
  }
});

test("parseStoredDrafts drops entries it cannot recognize", () => {
  const parsed = parseStoredDrafts(
    JSON.stringify({
      skill: {
        good: { description: "keep" },
        wrongType: { description: 42 },
        badTags: { tags: [1, 2] },
        notAnObject: "nope",
        empty: {},
      },
      tool: null,
      unexpectedKind: { a: { description: "b" } },
    }),
  );
  assert.deepEqual(Object.keys(parsed.skill), ["good"]);
  assert.deepEqual(parsed.tool, {});
});

test("parseStoredDrafts keeps a partially valid draft's usable half", () => {
  const parsed = parseStoredDrafts(
    JSON.stringify({ skill: { a: { description: "keep", tags: "nope" } } }),
  );
  assert.deepEqual(parsed.skill.a, { description: "keep" });
});

test("parseStoredDrafts caps how many drafts stored data can inject", () => {
  const oversized = Object.fromEntries(
    Array.from({ length: MAX_DRAFTS_PER_KIND + 25 }, (_, i) => [`s${i}`, { description: "x" }]),
  );
  const parsed = parseStoredDrafts(JSON.stringify({ skill: oversized }));
  assert.equal(Object.keys(parsed.skill).length, MAX_DRAFTS_PER_KIND);
});

test("setDraftField updates immutably", () => {
  const before = emptyDraftsByKind();
  const after = setDraftField(before, "skill", "a", "description", "hello");
  assert.deepEqual(before, emptyDraftsByKind());
  assert.equal(after.skill.a.description, "hello");

  const withTags = setDraftField(after, "skill", "a", "tags", ["x"]);
  assert.equal(withTags.skill.a.description, "hello");
  assert.deepEqual(withTags.skill.a.tags, ["x"]);
});

test("clearDraft removes one capability without touching the rest", () => {
  const drafts = setDraftField(
    setDraftField(emptyDraftsByKind(), "skill", "a", "description", "1"),
    "skill",
    "b",
    "description",
    "2",
  );
  const cleared = clearDraft(drafts, "skill", "a");
  assert.deepEqual(Object.keys(cleared.skill), ["b"]);
  assert.deepEqual(Object.keys(drafts.skill), ["a", "b"]);
});

test("countDrafts sums both kinds", () => {
  const drafts = setDraftField(
    setDraftField(emptyDraftsByKind(), "skill", "a", "description", "1"),
    "tool",
    "t",
    "description",
    "2",
  );
  assert.equal(countDrafts(drafts), 2);
  assert.equal(countDrafts(emptyDraftsByKind()), 0);
});
