import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkUsageLimit } from "@/lib/contracts/usage-limits";
import { createDrizzleVmStore } from "../adapters/drizzle-vm-store";
import type { VmStartCounts } from "../ports/vm-store";
import { createSandboxDb, PROJECT_ID } from "./support";

const VERSION_ID = "44444444-4444-4444-8444-444444444444";

async function setup(max: number) {
  const { db } = await createSandboxDb();
  const vms = createDrizzleVmStore(db);
  const check = async (starts: VmStartCounts) =>
    checkUsageLimit("sandbox_vm_starts_per_day", max, { current: starts.project });
  const start = () =>
    vms.claimStart({ projectId: PROJECT_ID, versionId: VERSION_ID, now: new Date() }, check);
  const claim = () => {
    const now = new Date();
    return vms.claim(
      {
        projectId: PROJECT_ID,
        versionId: VERSION_ID,
        runId: randomUUID(),
        maxRuns: 4,
        startedAfter: new Date(now.getTime() - 60_000),
        now,
      },
      check,
    );
  };
  return { vms, start, claim };
}

test("every VM start of the project today counts, of each purpose and state", async () => {
  const t = await setup(3);
  const prepare = await t.start();
  const smoke = await t.start();
  assert.ok(prepare.ok && smoke.ok);
  // A start whose VM did not start or is gone still counts: the budget counts attempts.
  await t.vms.markDeleted(prepare.vm.id, new Date());
  const run = await t.claim();
  assert.ok(run.ok && run.isNew);
  const refused = await t.start();
  assert.ok(!refused.ok);
  assert.deepEqual(
    [refused.limit, refused.max, refused.current],
    ["sandbox_vm_starts_per_day", 3, 3],
  );
});

test("starts that race for the last unit of the budget: exactly one gets it", async () => {
  const t = await setup(1);
  const results = await Promise.all([t.start(), t.claim(), t.start(), t.claim()]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  for (const result of results.filter((result) => !result.ok)) {
    assert.ok(!result.ok);
    assert.equal(result.limit, "sandbox_vm_starts_per_day");
    assert.equal(result.current, 1);
  }
});
