import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { SANDBOX_HARD_LIMITS, type UsageSubject } from "@/lib/contracts/usage-limits";
import { usageLimitsContract } from "@/lib/contracts/usage-limits.contract";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { createOssUsageLimits, ossUsageLimits } from "./usage-limits";

const SUBJECT: UsageSubject = { organizationId: "org-1", projectId: "p1" };

usageLimitsContract("in-memory fake", (limits) => createInMemoryUsageLimits(limits));
usageLimitsContract("core adapter", (limits) =>
  createOssUsageLimits(() => ({ ...SANDBOX_HARD_LIMITS, ...limits })),
);

test("the hard limits are the decided values", async () => {
  assert.deepEqual(SANDBOX_HARD_LIMITS, {
    sandbox_concurrent_instances: 50,
    sandbox_run_seconds: 1800,
    sandbox_runs_per_day: 5000,
    sandbox_versions_per_day: 100,
    sandbox_bundle_bytes: 2 * 1024 ** 3,
    sandbox_vm_starts_per_day: 500,
    sandbox_org_vm_starts_per_day: 5_000,
    sandbox_account_vm_starts_per_minute: 1_000,
    sandbox_account_vm_starts_per_hour: 20_000,
    sandbox_account_vm_starts_per_day: 100_000,
  });
  assert.equal(await ossUsageLimits.limit(SUBJECT, "sandbox_runs_per_day"), 5000);
});

test("an operator may lower a limit in the configuration, never raise it", async () => {
  const env = {
    SANDBOX_VERSIONS_PER_DAY: "2",
    SANDBOX_RUNS_PER_DAY: "999999",
    SANDBOX_VM_STARTS_PER_DAY: "20",
  };
  const config = resolveConfig({ env });
  const limits = createOssUsageLimits(() => config.sandboxes.limits);
  assert.equal(await limits.limit(SUBJECT, "sandbox_versions_per_day"), 2);
  assert.equal(await limits.limit(SUBJECT, "sandbox_runs_per_day"), 5000);
  assert.equal(await limits.limit(SUBJECT, "sandbox_vm_starts_per_day"), 20);
  const vm = await limits.check(SUBJECT, "sandbox_vm_starts_per_day", { current: 20 });
  assert.ok(!vm.ok && /sandbox_vm_starts_per_day/.test(vm.message));
});

test("the account budgets default to the paid plan, and an operator may raise them to the hard limit", async () => {
  assert.equal(await ossUsageLimits.limit(SUBJECT, "sandbox_account_vm_starts_per_minute"), 12);
  const config = resolveConfig({
    env: {
      SANDBOX_ACCOUNT_VM_STARTS_PER_DAY: "600",
      SANDBOX_ACCOUNT_VM_STARTS_PER_HOUR: "9999999",
    },
  });
  const limits = createOssUsageLimits(() => config.sandboxes.limits);
  assert.equal(await limits.limit(SUBJECT, "sandbox_account_vm_starts_per_day"), 600);
  assert.equal(await limits.limit(SUBJECT, "sandbox_account_vm_starts_per_hour"), 20_000);
  assert.equal(await limits.limit(SUBJECT, "sandbox_org_vm_starts_per_day"), 100);
});

test("the core has no daily budget: the operator pays its own model calls", async () => {
  assert.equal(await ossUsageLimits.dailyBudgetUsd(SUBJECT, "eval_judge"), null);
});
