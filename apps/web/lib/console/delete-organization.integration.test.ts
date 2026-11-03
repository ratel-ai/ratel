import assert from "node:assert/strict";
import { test } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  deleteOrganization,
  ensurePersonalOrganization,
  type MembershipView,
} from "@/lib/platform/identity/queries";
import { memberships, organizations, users } from "@/lib/platform/identity/schema";
import { toRole } from "@/lib/platform/organization";
import { resolveSessionContext, type SessionDeps } from "@/lib/platform/session";

type Db = ReturnType<typeof getDb>;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";

async function database(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into users (id, external_id, username, current_organization_id)
      values ('${USER}', 'local-operator', 'local-operator', '${ORG}');
    insert into memberships (user_id, organization_id, role) values ('${USER}', '${ORG}', 'admin');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Site Copilot', 'site-copilot');
    insert into api_keys (project_id, name, key_hash, key_prefix) values ('${PROJECT}', 'Default', 'hash', 'rtl_live_ab12');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

async function count(db: Db, query: string): Promise<number> {
  const rows = await db.execute(sql.raw(query));
  return Number((rows.rows[0] as { n: string | number }).n);
}

/** The session bridge's dependencies over the test database, as `lib/platform/session.ts` wires them. */
function sessionDeps(db: Db): SessionDeps {
  return {
    resolvePrincipal: async () => ({
      id: "local-operator",
      email: null,
      emailVerified: true,
      name: "Local operator",
      username: "local-operator",
      avatarUrl: null,
    }),
    actingAs: async () => null,
    upsertUser: async (input) => {
      const [row] = await db.select().from(users).where(eq(users.externalId, input.externalId));
      return row;
    },
    listMemberships: async (userId): Promise<MembershipView[]> => {
      const rows = await db
        .select({ organization: organizations, role: memberships.role })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
        .where(eq(memberships.userId, userId))
        .orderBy(asc(memberships.createdAt));
      return rows.map((row) => ({ organization: row.organization, role: toRole(row.role) }));
    },
    ensurePersonalOrganization: (params) => ensurePersonalOrganization(params, db),
    organizationName: () => null,
    setCurrentOrganization: async () => {},
    getOrganizationById: async () => null,
    getUserById: async () => null,
    trackProductEvent: async () => {},
  };
}

test("deleting the organization cascades to its projects, keys and memberships", async () => {
  const db = await database();

  await deleteOrganization(ORG, db);

  assert.equal(await count(db, `select count(*) as n from organizations where id = '${ORG}'`), 0);
  assert.equal(
    await count(db, `select count(*) as n from projects where organization_id = '${ORG}'`),
    0,
  );
  assert.equal(
    await count(db, `select count(*) as n from api_keys where project_id = '${PROJECT}'`),
    0,
  );
  assert.equal(
    await count(db, `select count(*) as n from memberships where organization_id = '${ORG}'`),
    0,
  );
  const [user] = await db.select().from(users).where(eq(users.id, USER));
  assert.equal(user.currentOrganizationId, null, "the pointer is healed, not left dangling");
});

test("the next request provisions a fresh, empty organization for the same operator", async () => {
  const db = await database();
  await deleteOrganization(ORG, db);

  const context = await resolveSessionContext(sessionDeps(db));

  assert.ok(context);
  assert.equal(context.personalOrganizationCreated, true);
  assert.notEqual(context.organization.id, ORG);
  assert.equal(context.role, "admin");
  assert.equal(context.user.currentOrganizationId, context.organization.id);
  assert.equal(
    await count(
      db,
      `select count(*) as n from projects where organization_id = '${context.organization.id}'`,
    ),
    0,
  );
});
