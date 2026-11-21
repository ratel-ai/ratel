import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOrganizationSettings } from "@/lib/platform/organization";

test("organization settings normalize a display name and URL slug", () => {
  assert.deepEqual(normalizeOrganizationSettings({ name: "  Acme Labs  ", slug: " Acme Labs! " }), {
    ok: true,
    name: "Acme Labs",
    slug: "acme-labs",
  });
  assert.deepEqual(normalizeOrganizationSettings({ name: " ", slug: "acme" }), {
    ok: false,
    error: "Organization name can't be empty.",
  });
  assert.deepEqual(normalizeOrganizationSettings({ name: "Acme", slug: "---" }), {
    ok: false,
    error: "Organization slug must include a letter or number.",
  });
});
