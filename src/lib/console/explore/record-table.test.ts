import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import {
  DEFAULT_SKILL_SORT,
  filterSkills,
  skillScope,
  sortSkills,
  toggleSort,
} from "@/lib/console/explore/record-table";

function skill(over: Partial<SkillFull> = {}): SkillFull {
  return {
    id: "id-1",
    name: "refunds",
    description: "Refund a customer order.",
    searchableDescription: null,
    tags: ["billing"],
    tools: ["payments"],
    status: "published",
    version: 1,
    endUserId: null,
    model: "claude-sonnet-5",
    updatedAt: "2026-06-01T00:00:00.000Z",
    publishedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
    metadata: {},
    body: "## Steps",
    ...over,
  };
}

const names = (xs: SkillFull[]) => xs.map((s) => s.name);

test("skillScope falls back to Global for unscoped skills", () => {
  assert.equal(skillScope(skill()), "Global");
  assert.equal(skillScope(skill({ endUserId: "u-ada" })), "u-ada");
});

test("filterSkills matches name and description case-insensitively, combined with status", () => {
  const xs = [
    skill({ name: "refunds", description: "Refund a customer order.", status: "published" }),
    skill({ name: "changelog", description: "Generate a RELEASE changelog.", status: "draft" }),
    skill({ name: "deploy", description: "Ship to production.", status: "archived" }),
  ];
  assert.deepEqual(names(filterSkills(xs, "refund", "all")), ["refunds"]);
  assert.deepEqual(
    names(filterSkills(xs, "release", "all")),
    ["changelog"],
    "description matches too",
  );
  assert.deepEqual(names(filterSkills(xs, "", "draft")), ["changelog"]);
  assert.deepEqual(names(filterSkills(xs, "release", "published")), [], "both filters must pass");
  assert.equal(filterSkills(xs, "  ", "all").length, 3, "whitespace-only query is no filter");
});

test("sortSkills: every key sorts both directions with a stable name tie-break", () => {
  const xs = [
    skill({
      name: "b",
      status: "draft",
      version: 3,
      tags: ["z"],
      tools: ["a", "b"],
      updatedAt: "2026-06-02T00:00:00.000Z",
    }),
    skill({
      name: "a",
      status: "published",
      version: 1,
      tags: ["a"],
      tools: [],
      updatedAt: "2026-06-03T00:00:00.000Z",
    }),
    skill({
      name: "c",
      status: "archived",
      version: 2,
      tags: ["m"],
      tools: ["x"],
      updatedAt: "2026-06-01T00:00:00.000Z",
    }),
  ];
  assert.deepEqual(names(sortSkills(xs, { key: "name", dir: "asc" })), ["a", "b", "c"]);
  assert.deepEqual(names(sortSkills(xs, { key: "name", dir: "desc" })), ["c", "b", "a"]);
  assert.deepEqual(names(sortSkills(xs, { key: "status", dir: "asc" })), ["c", "b", "a"]); // archived < draft < published
  assert.deepEqual(names(sortSkills(xs, { key: "version", dir: "asc" })), ["a", "c", "b"]);
  assert.deepEqual(names(sortSkills(xs, { key: "version", dir: "desc" })), ["b", "c", "a"]);
  assert.deepEqual(names(sortSkills(xs, { key: "tags", dir: "asc" })), ["a", "c", "b"]);
  assert.deepEqual(
    names(sortSkills(xs, { key: "tools", dir: "desc" })),
    ["b", "c", "a"],
    "tools sorts by count",
  );
  assert.deepEqual(names(sortSkills(xs, { key: "updatedAt", dir: "desc" })), ["a", "b", "c"]);
  assert.deepEqual(names(sortSkills(xs, { key: "updatedAt", dir: "asc" })), ["c", "b", "a"]);
});

test("sortSkills: scope sorts by label with Global as the fallback", () => {
  const xs = [
    skill({ name: "scoped-z", endUserId: "u-zoe" }),
    skill({ name: "global", endUserId: null }),
    skill({ name: "scoped-a", endUserId: "u-ada" }),
  ];
  assert.deepEqual(names(sortSkills(xs, { key: "scope", dir: "asc" })), [
    "global",
    "scoped-a",
    "scoped-z",
  ]);
});

test("sortSkills: a null model sorts LAST in both directions", () => {
  const xs = [
    skill({ name: "none", model: null }),
    skill({ name: "zeta", model: "zeta-model" }),
    skill({ name: "alpha", model: "alpha-model" }),
  ];
  assert.deepEqual(names(sortSkills(xs, { key: "model", dir: "asc" })), ["alpha", "zeta", "none"]);
  assert.deepEqual(names(sortSkills(xs, { key: "model", dir: "desc" })), ["zeta", "alpha", "none"]);
});

test("sortSkills never mutates its input", () => {
  const xs = [skill({ name: "b" }), skill({ name: "a" })];
  sortSkills(xs, { key: "name", dir: "asc" });
  assert.deepEqual(names(xs), ["b", "a"]);
});

test("toggleSort flips the active key and starts a new key asc (updatedAt: desc)", () => {
  assert.deepEqual(toggleSort(DEFAULT_SKILL_SORT, "updatedAt"), { key: "updatedAt", dir: "asc" });
  assert.deepEqual(toggleSort(DEFAULT_SKILL_SORT, "name"), { key: "name", dir: "asc" });
  assert.deepEqual(toggleSort({ key: "name", dir: "asc" }, "name"), { key: "name", dir: "desc" });
  assert.deepEqual(toggleSort({ key: "name", dir: "desc" }, "updatedAt"), {
    key: "updatedAt",
    dir: "desc",
  });
});
