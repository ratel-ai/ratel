import assert from "node:assert/strict";
import { test } from "node:test";
import { setEditionServiceName } from "@/lib/platform/app-config";
import { sourceLabel } from "@/lib/synthesis/match-quality/view";

/**
 * Copy that names the service in a module whose own test is upstream's copy: an override is named
 * for the edition's service, as Cloud names it, and for `APP_NAME` without one.
 */
test("with an edition, a match-quality override is named for its service", (t) => {
  assert.equal(sourceLabel("override"), "Ratel override");
  setEditionServiceName("Cloud");
  t.after(() => setEditionServiceName(undefined));
  assert.equal(sourceLabel("override"), "Cloud override");
});
