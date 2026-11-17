import assert from "node:assert/strict";
import { test } from "node:test";
import { semconvAliasesEnabled } from "./enabled";

/** Owned: upstream's end state (#402), the aliases read for every project. */

test("the aliases are read for every project, with or without an organization", async () => {
  assert.equal(await semconvAliasesEnabled("project-a", null), true);
  assert.equal(await semconvAliasesEnabled("project-b", "org-1"), true);
});
