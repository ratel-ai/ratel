import assert from "node:assert/strict";
import { test } from "node:test";
import { fixSeams } from "@/lib/views/fixes/seams";
import { howWeKnow, rewriteInputs } from "./fix-rewrites";

const failures = (...sources: string[]) => ({
  failures: sources.map((targetSource) => ({ targetSource, ourRank: null })),
});

test("how a rewrite's right answers were known: the majority, seen on a tie, null with neither", () => {
  assert.equal(howWeKnow(null), null);
  assert.equal(howWeKnow(failures("invoked", "invoked", "judge")), "seen");
  assert.equal(howWeKnow(failures("invoked", "judge")), "seen");
  assert.equal(howWeKnow(failures("judge", "judge", "invoked")), "judged");
});

test("no proposals make no rewrites, and loading the module fills the seam", () => {
  assert.deepEqual(rewriteInputs("p1", [], null), []);
  assert.equal(typeof fixSeams.loadRewrites, "function");
});
