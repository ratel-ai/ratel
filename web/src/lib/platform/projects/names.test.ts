import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeProjectName, selectActiveProject } from "@/lib/platform/projects/names";

const projects = [
  { id: "project-first", slug: "first", name: "First" },
  { id: "project-requested", slug: "requested", name: "Requested" },
];

test("selectActiveProject returns the project requested by slug", () => {
  assert.equal(selectActiveProject(projects, "requested"), projects[1]);
});

test("selectActiveProject falls back to the first project", () => {
  assert.equal(selectActiveProject(projects, "missing"), projects[0]);
  assert.equal(selectActiveProject(projects, null), projects[0]);
});

test("selectActiveProject returns undefined when there are no projects", () => {
  assert.equal(selectActiveProject([], "requested"), undefined);
});

test("project names are trimmed and bounded for settings updates", () => {
  assert.deepEqual(normalizeProjectName("  Support Copilot  "), {
    ok: true,
    name: "Support Copilot",
  });
  assert.deepEqual(normalizeProjectName("  "), {
    ok: false,
    error: "Project name can't be empty.",
  });
  assert.deepEqual(normalizeProjectName("x".repeat(61)), {
    ok: false,
    error: "Project name must be 60 characters or fewer.",
  });
});
