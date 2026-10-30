import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraftStore, type DraftStorage } from "./draft-store";
import { emptyDraftsByKind, setDraftField } from "./drafts";

function memoryStorage(initial: Record<string, string> = {}): DraftStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

test("the server snapshot is empty and referentially stable", () => {
  const store = createDraftStore("k", memoryStorage());
  assert.deepEqual(store.getServerSnapshot(), emptyDraftsByKind());
  // React compares snapshots by identity; a fresh object every call would loop.
  assert.equal(store.getServerSnapshot(), store.getServerSnapshot());
});

test("getSnapshot reads storage once and stays referentially stable", () => {
  let reads = 0;
  const store = createDraftStore("k", {
    getItem: () => {
      reads++;
      return JSON.stringify({ skill: { a: { description: "x" } }, tool: {} });
    },
    setItem: () => {},
  });

  const first = store.getSnapshot();
  const second = store.getSnapshot();
  assert.equal(reads, 1);
  assert.equal(first, second);
  assert.equal(first.skill.a.description, "x");
});

test("set writes through and invalidates the snapshot", () => {
  const storage = memoryStorage();
  const store = createDraftStore("k", storage);
  const next = setDraftField(emptyDraftsByKind(), "skill", "a", "description", "y");

  store.set(next);
  assert.equal(store.getSnapshot(), next);
  assert.deepEqual(JSON.parse(storage.getItem("k") ?? "null"), next);
});

test("a storage failure degrades to an in-memory draft rather than throwing", () => {
  const store = createDraftStore("k", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota exceeded");
    },
  });

  assert.deepEqual(store.getSnapshot(), emptyDraftsByKind());
  const next = setDraftField(emptyDraftsByKind(), "tool", "t", "description", "z");
  store.set(next);
  // The edit survives in memory even though nothing could be written.
  assert.equal(store.getSnapshot(), next);
});

test("a null storage (server render) yields empty drafts", () => {
  const store = createDraftStore("k", null);
  assert.deepEqual(store.getSnapshot(), emptyDraftsByKind());
});
