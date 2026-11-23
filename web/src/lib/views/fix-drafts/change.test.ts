import assert from "node:assert/strict";
import { test } from "node:test";
import { changeOf, emptyChange } from "@/lib/views/eval-gate/change";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";

test("a stored draft overrides the Quality proposal without changing the client-safe fallback", () => {
  const fix = buildFixes(fixesInput()).open.find((item) => item.source === "rewrite");
  assert.ok(fix);
  const original = changeOf(fix);
  const draft = { ...emptyChange(), patches: { lookup_order: "Find an order by its reference." } };
  assert.deepEqual(changeOf(fix, draft), draft);
  assert.deepEqual(changeOf(fix), original);
});
