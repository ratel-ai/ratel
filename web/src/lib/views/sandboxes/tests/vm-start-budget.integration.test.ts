import assert from "node:assert/strict";
import { test } from "node:test";
import { createOssUsageLimits } from "@/lib/adapters/oss/usage-limits";
import { SANDBOX_DEFAULT_LIMITS, type UsageLimitValues } from "@/lib/contracts/usage-limits";
import { createDrizzleVmStore } from "../adapters/drizzle-vm-store";
import { vmStartCheck } from "../vm-starts";
import { createSandboxDb, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

/**
 * The VM starts of one deployment share one provider account. Each project has its own budget, an
 * organization has one budget for all its projects, and the account has a budget for each minute,
 * hour and day over all projects.
 */

const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const FOREIGN_PROJECT_ID = "66666666-6666-4666-8666-666666666666";

async function setup(limits: Partial<UsageLimitValues>) {
  const { client, db } = await createSandboxDb();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${OTHER_ORGANIZATION_ID}', 'Globex', 'globex');
    insert into projects (id, organization_id, name, slug) values
      ('${FOREIGN_PROJECT_ID}', '${OTHER_ORGANIZATION_ID}', 'Foreign', 'foreign');
  `);
  const vms = createDrizzleVmStore(db);
  const usage = createOssUsageLimits(() => ({ ...SANDBOX_DEFAULT_LIMITS, ...limits }));
  const start = (projectId: string, organizationId = ORGANIZATION_ID) =>
    vms.claimStart(
      { projectId, versionId: VERSION_ID, now: new Date() },
      vmStartCheck(usage, { organizationId, projectId }),
    );
  return { start };
}

test("the defaults fit the paid plan of the provider", () => {
  assert.equal(SANDBOX_DEFAULT_LIMITS.sandbox_account_vm_starts_per_minute, 12);
  assert.equal(SANDBOX_DEFAULT_LIMITS.sandbox_account_vm_starts_per_hour, 60);
  assert.equal(SANDBOX_DEFAULT_LIMITS.sandbox_account_vm_starts_per_day, 200);
  assert.ok(
    SANDBOX_DEFAULT_LIMITS.sandbox_org_vm_starts_per_day <
      SANDBOX_DEFAULT_LIMITS.sandbox_account_vm_starts_per_day,
    "one organization cannot take the whole account",
  );
});

test("a second project still starts after the first used its own daily limit", async () => {
  const t = await setup({ sandbox_vm_starts_per_day: 2 });
  assert.ok((await t.start(PROJECT_ID)).ok);
  assert.ok((await t.start(PROJECT_ID)).ok);
  const refused = await t.start(PROJECT_ID);
  assert.ok(!refused.ok);
  assert.equal(refused.limit, "sandbox_vm_starts_per_day");
  assert.ok((await t.start(FOREIGN_PROJECT_ID, OTHER_ORGANIZATION_ID)).ok);
});

test("the account budget refuses a start of each project when it is exhausted", async () => {
  for (const [limit, value] of [
    ["sandbox_account_vm_starts_per_minute", 2],
    ["sandbox_account_vm_starts_per_hour", 2],
    ["sandbox_account_vm_starts_per_day", 2],
  ] as const) {
    const t = await setup({ [limit]: value });
    assert.ok((await t.start(PROJECT_ID)).ok);
    assert.ok((await t.start(FOREIGN_PROJECT_ID, OTHER_ORGANIZATION_ID)).ok);
    const refused = await t.start(OTHER_PROJECT_ID);
    assert.ok(!refused.ok, limit);
    assert.deepEqual([refused.limit, refused.max, refused.current], [limit, 2, 2]);
    assert.match(refused.message, new RegExp(limit));
  }
});

test("the organization cap counts the starts of all its projects", async () => {
  const t = await setup({ sandbox_org_vm_starts_per_day: 2 });
  assert.ok((await t.start(PROJECT_ID)).ok);
  assert.ok((await t.start(OTHER_PROJECT_ID)).ok);
  const refused = await t.start(OTHER_PROJECT_ID);
  assert.ok(!refused.ok);
  assert.deepEqual([refused.limit, refused.current], ["sandbox_org_vm_starts_per_day", 2]);
  // Another organization has its own cap.
  assert.ok((await t.start(FOREIGN_PROJECT_ID, OTHER_ORGANIZATION_ID)).ok);
});

test("starts of two projects that race for the last unit of the account: exactly one gets it", async () => {
  const t = await setup({ sandbox_account_vm_starts_per_minute: 1 });
  const results = await Promise.all([
    t.start(PROJECT_ID),
    t.start(FOREIGN_PROJECT_ID, OTHER_ORGANIZATION_ID),
    t.start(OTHER_PROJECT_ID),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});
