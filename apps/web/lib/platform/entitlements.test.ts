import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billableProjectCount,
  checkMeteredFeature,
  checkQuota,
  getAgentHealthLimits,
  getLimits,
  hasPaidAccess,
  mergeLimitOverrides,
  planLabel,
  resolvePlanId,
} from "./entitlements";

const org = { id: "org_1" };

test("the shim answers from the composed edition: unlimited, plan oss", () => {
  assert.equal(resolvePlanId(org), "oss");
  assert.equal(planLabel(org), "Oss");
  assert.equal(hasPaidAccess(org), true);
  assert.equal(getLimits(org).maxProjects, Number.POSITIVE_INFINITY);
  assert.deepEqual(checkQuota(org, "maxMembers", 10_000), { ok: true });
  assert.equal(checkMeteredFeature(org, "matchQualityRunsPerMonth", 3, "Match quality").ok, true);
});

test("agent health limits are the three window fields", () => {
  assert.deepEqual(Object.keys(getAgentHealthLimits(org)).sort(), [
    "agentHealthEvidenceTurns",
    "agentHealthSignalsShown",
    "agentHealthWindowDays",
  ]);
});

test("limit overrides merge per editable field and collapse to null when empty", () => {
  assert.deepEqual(
    mergeLimitOverrides({ maxProjects: 2, matchQualityRunsPerMonth: 9 }, { maxProjects: 5 }, [
      "maxProjects",
      "maxMembers",
    ]),
    { matchQualityRunsPerMonth: 9, maxProjects: 5 },
  );
  assert.equal(mergeLimitOverrides({ maxProjects: 2 }, {}, ["maxProjects"]), null);
});

test("the demo project never counts against the project cap", () => {
  assert.equal(billableProjectCount([{ isDemo: true }, { isDemo: false }, {}]), 2);
});
