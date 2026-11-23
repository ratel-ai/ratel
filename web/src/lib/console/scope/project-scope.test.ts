import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { Session } from "@/lib/contracts/session";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getProjectById } from "@/lib/platform/projects/queries";
import { resolveProjectScope } from "./project-scope";

/**
 * The rule the console's project scope applies, run against the same read it uses: a project is
 * readable by a member of its own organization, with that membership's role, whichever
 * organization is active (upstream's `resolveProjectScopeOrNull`). The React cache and
 * `notFound()` wrappers are Next's; the rule is what this test covers.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OUTSIDE_ORG = "55555555-5555-4555-8555-555555555555";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const OUTSIDE_PROJECT = "66666666-6666-4666-8666-666666666666";

type Db = ReturnType<typeof getDb>;

const acme = { id: ORG, name: "Acme", slug: "acme" };
const other = { id: OTHER_ORG, name: "Other", slug: "other" };

const user = {
  id: "u1",
  externalId: "user_1",
  email: null,
  name: null,
  username: null,
  avatarUrl: null,
};

/** Active in Acme (admin), also a member of Other. */
const twoOrganizations: Session = {
  user,
  organization: acme,
  role: "admin",
  memberships: [
    { organization: acme, role: "admin" },
    { organization: other, role: "member" },
  ],
};

/** The open-source session: one organization, one membership. */
const oneOrganization: Session = {
  user,
  organization: acme,
  role: "admin",
  memberships: [{ organization: acme, role: "admin" }],
};

async function database() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values
      ('${ORG}', 'Acme', 'acme'), ('${OTHER_ORG}', 'Other', 'other'), ('${OUTSIDE_ORG}', 'Outside', 'outside');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'),
      ('${OTHER_PROJECT}', '${OTHER_ORG}', 'Theirs', 'theirs'),
      ('${OUTSIDE_PROJECT}', '${OUTSIDE_ORG}', 'Outside', 'outside');
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  return { client, read: (id: string) => getProjectById(id, db) };
}

test("a member of a non-active organization opens its project, with that organization and role", async () => {
  const { client, read } = await database();
  const scope = await resolveProjectScope(OTHER_PROJECT, twoOrganizations, read);
  assert.equal(scope?.project.id, OTHER_PROJECT);
  assert.deepEqual(scope?.organization, other);
  assert.equal(scope?.role, "member");
  assert.equal(scope?.user, user);
  const own = await resolveProjectScope(PROJECT, twoOrganizations, read);
  assert.deepEqual(own?.organization, acme);
  assert.equal(own?.role, "admin");
  await client.close();
});

test("an outsider gets nothing, and a malformed id reads as none", async () => {
  const { client, read } = await database();
  assert.equal(await resolveProjectScope(OUTSIDE_PROJECT, twoOrganizations, read), null);
  assert.equal(await resolveProjectScope("not-a-uuid", twoOrganizations, read), null);
  assert.equal(
    await resolveProjectScope("77777777-7777-4777-8777-777777777777", twoOrganizations, read),
    null,
  );
  await client.close();
});

test("open source: one membership answers exactly as before", async () => {
  const { client, read } = await database();
  const scope = await resolveProjectScope(PROJECT, oneOrganization, read);
  assert.deepEqual(
    { project: scope?.project.id, organization: scope?.organization, role: scope?.role },
    { project: PROJECT, organization: oneOrganization.organization, role: oneOrganization.role },
  );
  assert.equal(await resolveProjectScope(OTHER_PROJECT, oneOrganization, read), null);
  await client.close();
});
