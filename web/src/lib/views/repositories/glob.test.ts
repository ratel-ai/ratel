import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesBranch, matchesPath } from "./glob";

test("a branch pattern matches the whole name, * stops at a slash", () => {
  assert.equal(matchesBranch("main", "main"), true);
  assert.equal(matchesBranch("main", "main-2"), false);
  assert.equal(matchesBranch("release/*", "release/1.2"), true);
  assert.equal(matchesBranch("release/*", "release/1.2/hotfix"), false);
  assert.equal(matchesBranch("release/**", "release/1.2/hotfix"), true);
  assert.equal(matchesBranch("v?", "v1"), true);
});

test("a branch pattern treats regex characters as text", () => {
  assert.equal(matchesBranch("feat+x", "feat+x"), true);
  assert.equal(matchesBranch("a.b", "axb"), false);
});

test("a path pattern with no slash matches the file name at any depth", () => {
  assert.equal(matchesPath("Dockerfile", "Dockerfile"), true);
  assert.equal(matchesPath("Dockerfile", "agent/Dockerfile"), true);
  assert.equal(matchesPath("*.md", "docs/guide/intro.md"), true);
  assert.equal(matchesPath("*.md", "intro.mdx"), false);
});

test("a path pattern with a slash is anchored at the root", () => {
  assert.equal(matchesPath("docs/**", "docs/a/b.txt"), true);
  assert.equal(matchesPath("docs/**", "src/docs/a.txt"), false);
  assert.equal(matchesPath("**/prompts/**", "prompts/refund.md"), true);
  assert.equal(matchesPath("**/prompts/**", "src/agent/prompts/refund.md"), true);
  assert.equal(matchesPath("src/*.ts", "src/a/b.ts"), false);
});
