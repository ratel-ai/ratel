import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { LOCAL_ORG_SLUG, resolveSeedOrganization } from "@/lib/console/seed/replace-project";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

type Db = ReturnType<typeof getDb>;

async function database(sql = "") {
  const client = await createMigratedPGlite();
  if (sql) await client.exec(sql);
  return drizzle(client, { schema }) as unknown as Db;
}

const org = (id: string, slug: string) =>
  `insert into organizations (id, name, slug) values ('${id}', '${slug}', '${slug}');`;
const member = (userId: string, orgId: string) => `
  insert into users (id, external_id) values ('${userId}', '${userId}');
  insert into memberships (user_id, organization_id) values ('${userId}', '${orgId}');`;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const noConsole = async () => {
  throw new Error("must not open the console");
};

test("a named slug wins, and an unknown one throws", async () => {
  const db = await database(org(A, "acme") + org(B, LOCAL_ORG_SLUG));
  assert.deepEqual(await resolveSeedOrganization(db, "acme", noConsole), { id: A, slug: "acme" });
  await assert.rejects(
    resolveSeedOrganization(db, "nope", noConsole),
    /no organization with slug "nope"/,
  );
});

test("without a slug, the operator's organization wins, members or not", async () => {
  const db = await database(org(A, "acme") + member(U1, A) + org(B, LOCAL_ORG_SLUG));
  assert.deepEqual(await resolveSeedOrganization(db, undefined, noConsole), {
    id: B,
    slug: LOCAL_ORG_SLUG,
  });
});

test("else the only organization with a member", async () => {
  const db = await database(org(A, "acme") + member(U1, A) + org(B, "empty"));
  assert.deepEqual(await resolveSeedOrganization(db, undefined, noConsole), {
    id: A,
    slug: "acme",
  });
});

test("several organizations with members and no operator's: throws and lists them", async () => {
  const db = await database(org(A, "acme") + member(U1, A) + org(B, "beta") + member(U2, B));
  await assert.rejects(
    resolveSeedOrganization(db, undefined, noConsole),
    /pass one: (acme, beta|beta, acme)/,
  );
});

test("no organization with a member: provisions the operator's the way a console visit does", async () => {
  const db = await database(org(B, "empty"));
  let opened = 0;
  const openConsole = async () => {
    opened++;
    return { id: A, slug: LOCAL_ORG_SLUG };
  };
  assert.deepEqual(await resolveSeedOrganization(db, undefined, openConsole), {
    id: A,
    slug: LOCAL_ORG_SLUG,
  });
  assert.equal(opened, 1);
});

test("no organization with a member and no session to provision one: throws", async () => {
  const db = await database();
  await assert.rejects(
    resolveSeedOrganization(db, undefined, async () => null),
    /No organization has a member/,
  );
});
