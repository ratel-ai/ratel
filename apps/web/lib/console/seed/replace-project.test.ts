import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_ORGANIZATION_ID } from "@/lib/adapters/oss/session";
import { resolveSeedOrganization } from "@/lib/console/seed/replace-project";

const ACME = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme", slug: "acme" };
const known = async (id: string) => (id === ACME.id ? ACME : null);

test("a named organization id wins", async () => {
  assert.deepEqual(await resolveSeedOrganization(ACME.id, known), ACME);
});

test("without one, the open-source operator's organization", async () => {
  const org = await resolveSeedOrganization();
  assert.equal(org.id, LOCAL_ORGANIZATION_ID);
});

test("an organization the edition does not know throws", async () => {
  await assert.rejects(resolveSeedOrganization("nope", known), /no organization "nope"/);
});
