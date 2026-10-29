import assert from "node:assert/strict";
import { test } from "node:test";
import { stableProjectId } from "@/lib/console/seed/replace-project";

const ORG = "22222222-2222-4222-8222-222222222222";

test("the id is sha256 of the organization and slug, laid out as a version 8 UUID", () => {
  // sha256("project:<ORG>:site-copilot") = 26cc54cb0024ba2b8aa29421f95367570e71...
  assert.equal(stableProjectId(ORG, "site-copilot"), "26cc54cb-0024-8a2b-8aa2-9421f9536757");
});

test("the same input gives the same id; another org or slug gives another", () => {
  const id = stableProjectId(ORG, "site-copilot");
  assert.equal(stableProjectId(ORG, "site-copilot"), id);
  assert.notEqual(stableProjectId(ORG, "other"), id);
  assert.notEqual(stableProjectId("33333333-3333-4333-8333-333333333333", "site-copilot"), id);
});

test("version nibble is 8 and the variant is RFC 4122 for any input", () => {
  for (let i = 0; i < 64; i++) {
    assert.match(
      stableProjectId(ORG, `slug-${i}`),
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
});
