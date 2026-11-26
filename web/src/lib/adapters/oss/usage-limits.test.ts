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
  });
  assert.equal(await ossUsageLimits.limit(SUBJECT, "sandbox_runs_per_day"), 5000);
});

test("an operator may lower a limit in the configuration, never raise it", async () => {
  const env = { SANDBOX_VERSIONS_PER_DAY: "2", SANDBOX_RUNS_PER_DAY: "999999" };
  const config = resolveConfig({ env });
  const limits = createOssUsageLimits(() => config.sandboxes.limits);
  assert.equal(await limits.limit(SUBJECT, "sandbox_versions_per_day"), 2);
  assert.equal(await limits.limit(SUBJECT, "sandbox_runs_per_day"), 5000);
});

test("the core has no daily budget: the operator pays its own model calls", async () => {
  assert.equal(await ossUsageLimits.dailyBudgetUsd(SUBJECT, "eval_judge"), null);
});
