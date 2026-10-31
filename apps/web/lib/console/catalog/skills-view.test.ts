import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SKILLS_VIEW,
  filterSkillItems,
  itemMatchesQuery,
  resolveSkillsView,
  sortSkillItems,
} from "./skills-view";
import { runtimeDefinition, skillItems, skillRecord } from "./test-support";

const items = skillItems({
  skills: [
    skillRecord("review-pull-request", {
      description: "Review a pull request.",
      updatedAt: "2026-10-03T00:00:00.000Z",
    }),
    skillRecord("write-unit-tests", { status: "draft", updatedAt: "2026-10-05T00:00:00.000Z" }),
    skillRecord("deploy-service", { status: "archived", updatedAt: "2026-09-01T00:00:00.000Z" }),
  ],
  runtimeSkills: [
    runtimeDefinition("triage-incident", { lastSeenAt: new Date("2026-10-04T00:00:00.000Z") }),
    { entryId: null, name: "legacy", provenance: "observed", lastSeenAt: new Date("not a date") },
  ],
  runs: {
    "review-pull-request": { runs: 5, lastRunAt: null },
    "triage-incident": { runs: 9, lastRunAt: null },
  },
});
const names = (list: { name: string }[]) => list.map((item) => item.name);

test("the view reads from the URL and falls back to newest first", () => {
  assert.deepEqual(resolveSkillsView(new URLSearchParams("")), DEFAULT_SKILLS_VIEW);
  assert.deepEqual(resolveSkillsView(new URLSearchParams("q=pr&status=draft&sort=runs&dir=asc")), {
    query: "pr",
    status: "draft",
    sort: "runs",
    direction: "asc",
  });
  assert.deepEqual(
    resolveSkillsView(new URLSearchParams("status=deleted&sort=size&dir=up")),
    DEFAULT_SKILLS_VIEW,
  );
});

test("search matches names and descriptions; a status keeps Ratel skills only", () => {
  assert.deepEqual(names(filterSkillItems(items, { query: "PULL request", status: "all" })), [
    "review-pull-request",
  ]);
  assert.deepEqual(names(filterSkillItems(items, { query: "", status: "draft" })), [
    "write-unit-tests",
  ]);
  assert.equal(filterSkillItems(items, { query: "", status: "all" }).length, 5);
});

test("sorting by date puts unknown dates last both ways; ties fall back to the name", () => {
  assert.deepEqual(names(sortSkillItems(items, "updated", "desc")), [
    "write-unit-tests",
    "triage-incident",
    "review-pull-request",
    "deploy-service",
    "legacy",
  ]);
  assert.deepEqual(names(sortSkillItems(items, "updated", "asc")).at(-1), "legacy");
  assert.deepEqual(names(sortSkillItems(items, "runs", "desc")).slice(0, 2), [
    "triage-incident",
    "review-pull-request",
  ]);
  assert.deepEqual(names(sortSkillItems(items, "name", "asc")), [
    "deploy-service",
    "legacy",
    "review-pull-request",
    "triage-incident",
    "write-unit-tests",
  ]);
  assert.equal(names(items)[0], "review-pull-request", "the input order is untouched");
});

test("the search box matches the searchable description the tables show", () => {
  const item = {
    name: "lookup_order",
    agentDescription: "Find an order.",
    searchable: { text: "refunds and returns" },
  };
  assert.equal(itemMatchesQuery(item, "refunds"), true);
  assert.equal(itemMatchesQuery(item, "LOOKUP"), true);
  assert.equal(itemMatchesQuery(item, "invoice"), false);
  assert.equal(itemMatchesQuery({ ...item, searchable: null }, "refunds"), false);
  assert.equal(itemMatchesQuery(item, "  "), true);
});
