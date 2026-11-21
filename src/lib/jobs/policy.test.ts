import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_BUDGET_MS, JOB_TIER, jobBudgetMs, jobTier } from "@/lib/jobs/policy";

test("every kind has a tier and a budget, and an unknown kind waits with the sweeps", () => {
  assert.deepEqual(Object.keys(JOB_TIER).sort(), Object.keys(JOB_BUDGET_MS).sort());
  assert.equal(jobTier("simulate_fix_eval"), 0);
  assert.equal(jobTier("build_trace_turns"), 1);
  assert.equal(jobTier("craft_tools"), 2);
  assert.equal(jobTier("a_kind_from_a_newer_deploy"), 2);
  assert.equal(jobBudgetMs("a_kind_from_a_newer_deploy"), 5 * 60_000);
  for (const budget of Object.values(JOB_BUDGET_MS)) assert.ok(budget > 0);
});
