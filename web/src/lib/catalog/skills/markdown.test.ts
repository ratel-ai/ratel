import assert from "node:assert/strict";
import { test } from "node:test";
import { toSkillMarkdown } from "./markdown";

test("toSkillMarkdown assembles frontmatter + body", () => {
  const md = toSkillMarkdown({
    name: "deploy-preview",
    description: "Ship a preview.",
    tags: ["deploy"],
    body: "## Steps\n1. go",
  });
  assert.match(
    md,
    /^---\nname: deploy-preview\ndescription: Ship a preview\.\ntags: \[deploy\]\n---/,
  );
  assert.match(md, /## Steps/);
});

test("toSkillMarkdown omits an empty tags line", () => {
  assert.equal(
    toSkillMarkdown({ name: "n", description: "d", tags: [], body: "## H\nbody" }),
    "---\nname: n\ndescription: d\n---\n\n## H\nbody\n",
  );
  assert.match(
    toSkillMarkdown({ name: "n", description: "d", tags: ["a", "b"], body: "x" }),
    /tags: \[a, b\]/,
  );
});
