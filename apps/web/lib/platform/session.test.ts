import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@/lib/contracts/session";
import { membershipBySlug, membershipIn, sessionForOrganization } from "./session";

const acme = { id: "o-acme", name: "Acme", slug: "acme" };
const beta = { id: "o-beta", name: "Beta", slug: "beta" };

const session: Pick<Session, "memberships"> = {
  memberships: [
    { organization: acme, role: "admin" },
    { organization: beta, role: "member" },
  ],
};

test("a membership is found by organization id with its own role, whichever is active", () => {
  assert.deepEqual(membershipIn(session, beta.id), { organization: beta, role: "member" });
  assert.equal(membershipIn(session, "o-other"), null);
});

test("a membership is found by slug, and an unknown slug is none", () => {
  assert.deepEqual(membershipBySlug(session, "acme"), { organization: acme, role: "admin" });
  assert.equal(membershipBySlug(session, "other"), null);
});

test("an action's organization is any membership, with its role; another is none", () => {
  const full: Session = {
    user: { id: "u", externalId: "x", email: null, name: null, username: null, avatarUrl: null },
    organization: acme,
    role: "admin",
    memberships: session.memberships,
  };
  assert.equal(sessionForOrganization(full), full);
  assert.equal(sessionForOrganization(full, acme.id), full);
  assert.deepEqual(sessionForOrganization(full, beta.id), {
    ...full,
    organization: beta,
    role: "member",
  });
  assert.equal(sessionForOrganization(full, "o-other"), null);
});
