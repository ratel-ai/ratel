import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@/lib/contracts/session";
import { resolveOrganizationScope } from "./organization-scope";

/**
 * Upstream's `resolveOrganizationScope`: an organization page opens for a member of that
 * organization, with their role in it, whichever organization is active; any other slug is none.
 */

const acme = { id: "o-acme", name: "Acme", slug: "acme" };
const beta = { id: "o-beta", name: "Beta", slug: "beta" };
const user = {
  id: "u1",
  externalId: "user_1",
  email: null,
  name: null,
  username: null,
  avatarUrl: null,
};

const session: Session = {
  user,
  organization: acme,
  role: "admin",
  memberships: [
    { organization: acme, role: "admin" },
    { organization: beta, role: "member" },
  ],
};

test("a member of a non-active organization opens its pages, with their role there", () => {
  assert.deepEqual(resolveOrganizationScope("beta", session), {
    organization: beta,
    role: "member",
    user,
  });
  assert.deepEqual(resolveOrganizationScope("acme", session)?.role, "admin");
});

test("an outsider gets nothing", () => {
  assert.equal(resolveOrganizationScope("other", session), null);
});

test("open source: the one organization's slug opens and every other is none", () => {
  const one: Session = { ...session, memberships: [{ organization: acme, role: "admin" }] };
  assert.deepEqual(resolveOrganizationScope("acme", one), {
    organization: one.organization,
    role: one.role,
    user,
  });
  assert.equal(resolveOrganizationScope("beta", one), null);
});
