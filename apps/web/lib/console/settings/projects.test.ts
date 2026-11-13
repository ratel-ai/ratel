import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterProjects,
  projectListItems,
  projectUsageLabel,
} from "@/lib/console/settings/projects";

const PROJECTS = [
  {
    id: "p1",
    name: "Support bot",
    slug: "support-bot",
    isDemo: false,
    createdAt: new Date("2026-09-14T08:00:00.000Z"),
  },
  {
    id: "p 2",
    name: "Café agent",
    slug: "cafe",
    isDemo: true,
    createdAt: new Date("2026-10-01T08:00:00.000Z"),
  },
];

test("each project links to its own page and says when it is the demo", () => {
  const items = projectListItems(PROJECTS);
  assert.deepEqual(
    items.map((item) => [item.name, item.href, item.isDemo, item.created]),
    [
      ["Support bot", "/project/p1", false, "Sep 14, 2026"],
      ["Café agent", "/project/p%202", true, "Oct 1, 2026"],
    ],
  );
});

test("search matches the name or the slug, ignoring case and accents", () => {
  const items = projectListItems(PROJECTS);
  assert.deepEqual(
    filterProjects(items, "").map((item) => item.id),
    ["p1", "p 2"],
  );
  assert.deepEqual(
    filterProjects(items, "  BOT ").map((item) => item.id),
    ["p1"],
  );
  assert.deepEqual(
    filterProjects(items, "cafe agent").map((item) => item.id),
    ["p 2"],
    "Café matches cafe",
  );
  assert.deepEqual(
    filterProjects(items, "support-b").map((item) => item.id),
    ["p1"],
  );
  assert.deepEqual(filterProjects(items, "nothing"), []);
});

test("the plan's room reads as a count, Enterprise as unlimited", () => {
  assert.equal(projectUsageLabel({ used: 2, limit: 3 }), "2 of 3 projects");
  assert.equal(projectUsageLabel({ used: 1, limit: 1 }), "1 of 1 project");
  assert.equal(
    projectUsageLabel({ used: 4, limit: Number.POSITIVE_INFINITY }),
    "4 of unlimited projects",
  );
});
