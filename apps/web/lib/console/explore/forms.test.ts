import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCreatePayload,
  buildEditPayload,
  hasEdits,
  parseList,
  type SkillFormValues,
  type SkillOriginal,
} from "./forms";

function values(over: Partial<SkillFormValues> = {}): SkillFormValues {
  return {
    name: "make-changelog",
    description: "Generate a changelog",
    searchableDescription: "",
    useSearchableDescription: false,
    body: "# Changelog\n...",
    tags: "git, docs",
    tools: "read_file, write_file",
    status: "draft",
    model: "",
    endUser: "",
    ...over,
  };
}

const original: SkillOriginal = {
  name: "make-changelog",
  description: "Generate a changelog",
  searchableDescription: null,
  body: "# Changelog\n...",
  tags: ["git", "docs"],
  tools: ["read_file", "write_file"],
  endUserId: null,
};

test("parseList trims, drops empties, and de-duplicates preserving order", () => {
  assert.deepEqual(parseList("a, b ,, a, c"), ["a", "b", "c"]);
  assert.deepEqual(parseList("  "), []);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList("solo"), ["solo"]);
});

test("buildCreatePayload maps fields, parses lists, trims name", () => {
  const body = buildCreatePayload(values({ name: "  make-changelog  " }), "proj");
  assert.equal(body.project, "proj");
  assert.equal(body.name, "make-changelog");
  assert.deepEqual(body.tags, ["git", "docs"]);
  assert.deepEqual(body.tools, ["read_file", "write_file"]);
  assert.equal(body.status, "draft");
});

test("buildCreatePayload includes model only when non-empty", () => {
  assert.equal("model" in buildCreatePayload(values({ model: "" }), "p"), false);
  assert.equal("model" in buildCreatePayload(values({ model: "  " }), "p"), false);
  assert.equal(
    buildCreatePayload(values({ model: " claude-sonnet-5 " }), "p").model,
    "claude-sonnet-5",
  );
});

test("buildEditPayload includes only changed fields plus the version guard", () => {
  const unchanged = buildEditPayload(values(), original, 3);
  assert.deepEqual(unchanged, { expectedVersion: 3 });
  assert.equal(hasEdits(unchanged), false);

  const edited = buildEditPayload(
    values({ description: "Generate a nice changelog" }),
    original,
    3,
  );
  assert.deepEqual(edited, { expectedVersion: 3, description: "Generate a nice changelog" });
  assert.equal(hasEdits(edited), true);
});

test("buildCreatePayload includes endUserId only when the scope field is non-empty", () => {
  assert.equal("endUserId" in buildCreatePayload(values({ endUser: "" }), "p"), false);
  assert.equal("endUserId" in buildCreatePayload(values({ endUser: "  " }), "p"), false);
  assert.equal(buildCreatePayload(values({ endUser: " u-ada " }), "p").endUserId, "u-ada");
});

test("buildEditPayload scope is tri-state: unchanged absent, re-scope string, cleared null", () => {
  // Global → global: absent.
  assert.deepEqual(buildEditPayload(values({ endUser: "" }), original, 2), { expectedVersion: 2 });
  // Global → scoped: the id.
  assert.deepEqual(buildEditPayload(values({ endUser: "u-ada" }), original, 2), {
    expectedVersion: 2,
    endUserId: "u-ada",
  });
  const scopedOriginal: SkillOriginal = { ...original, endUserId: "u-ada" };
  // Scoped → same scope: absent.
  assert.deepEqual(buildEditPayload(values({ endUser: " u-ada " }), scopedOriginal, 2), {
    expectedVersion: 2,
  });
  // Scoped → cleared: explicit null (the wire's "make it global").
  const cleared = buildEditPayload(values({ endUser: "" }), scopedOriginal, 2);
  assert.deepEqual(cleared, { expectedVersion: 2, endUserId: null });
  assert.equal(hasEdits(cleared), true, "clearing the scope counts as an edit");
  // Scoped → different user: the new id.
  assert.deepEqual(buildEditPayload(values({ endUser: "u-bob" }), scopedOriginal, 2), {
    expectedVersion: 2,
    endUserId: "u-bob",
  });
});

test("buildEditPayload detects tag/tool list changes (add, remove, reorder)", () => {
  assert.deepEqual(buildEditPayload(values({ tags: "git, docs, ci" }), original, 1), {
    expectedVersion: 1,
    tags: ["git", "docs", "ci"],
  });
  // Reorder is a change (PATCH replaces the whole array).
  assert.deepEqual(buildEditPayload(values({ tools: "write_file, read_file" }), original, 1), {
    expectedVersion: 1,
    tools: ["write_file", "read_file"],
  });
  // Whitespace-only difference collapses to the same list → no change.
  assert.deepEqual(buildEditPayload(values({ tags: " git ,docs " }), original, 1), {
    expectedVersion: 1,
  });
});

test("searchable description create payload preserves unset, set, and explicit empty", () => {
  assert.equal(buildCreatePayload(values(), "p").searchableDescription, null);
  assert.equal(
    buildCreatePayload(
      values({ useSearchableDescription: true, searchableDescription: "release rollback" }),
      "p",
    ).searchableDescription,
    "release rollback",
  );
  assert.equal(
    buildCreatePayload(values({ useSearchableDescription: true, searchableDescription: "" }), "p")
      .searchableDescription,
    "",
  );
});

test("searchable description edit payload can set, edit, and clear the override", () => {
  assert.deepEqual(
    buildEditPayload(
      values({ useSearchableDescription: true, searchableDescription: "release rollback" }),
      original,
      3,
    ),
    { expectedVersion: 3, searchableDescription: "release rollback" },
  );

  const overridden: SkillOriginal = {
    ...original,
    searchableDescription: "release rollback",
  };
  assert.deepEqual(
    buildEditPayload(
      values({ useSearchableDescription: true, searchableDescription: "deploy canary" }),
      overridden,
      4,
    ),
    { expectedVersion: 4, searchableDescription: "deploy canary" },
  );
  assert.deepEqual(buildEditPayload(values(), overridden, 4), {
    expectedVersion: 4,
    searchableDescription: null,
  });
});
