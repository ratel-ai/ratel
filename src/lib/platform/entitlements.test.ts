import assert from "node:assert/strict";
import { test } from "node:test";
import { composition } from "@/lib/composition/ports";
import type { PlanCatalog } from "@/lib/contracts/entitlements";
import {
  billableProjectCount,
  billingSelfServe,
  checkEventQuota,
  checkMeteredFeature,
  checkQuota,
  fullAgentHealthPlanName,
  getAgentHealthLimits,
  getLimits,
  hasPaidAccess,
  incrementEventUsage,
  mergeLimitOverrides,
  planLabel,
  planName,
  planSummary,
  planWithWindow,
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

test("the event quota shim allows and records through the composed edition", async () => {
  assert.deepEqual(await checkEventQuota(org), { ok: true });
  await incrementEventUsage(org.id, 250);
  await incrementEventUsage(org.id, 0);
  assert.deepEqual(await checkEventQuota(org), { ok: true });
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

test("without an edition's plans: no summary, no plan named, billing never self-serve", () => {
  assert.equal(composition.entitlements.plans, undefined);
  assert.equal(planSummary(org), null);
  assert.equal(planWithWindow(30), null);
  assert.equal(fullAgentHealthPlanName(), null);
  assert.equal(planName("plus"), "Plus");
  assert.equal(billingSelfServe(org), false);
});

test("with an edition's plans, the shim answers from them", (t) => {
  const plans: PlanCatalog = {
    summary: (view) => ({
      id: "plus",
      name: "Plus",
      paid: true,
      subscriptionStatus: "active",
      pastDue: false,
      currentPeriodEnd: null,
      selfServeBilling: view.id === "org_1",
    }),
    withAgentHealthWindow: (days) => (days <= 30 ? "plus" : "pro"),
    withFullAgentHealth: () => "plus",
    name: (planId) => ({ plus: "Plus", pro: "Pro" })[planId] ?? "Hobby",
  };
  const previous = composition.entitlements;
  composition.entitlements = { ...previous, planId: () => "pro", plans };
  t.after(() => {
    composition.entitlements = previous;
  });

  assert.equal(planSummary(org)?.name, "Plus");
  assert.equal(billingSelfServe(org), true);
  assert.equal(billingSelfServe({ id: "org_2" }), false);
  assert.equal(planWithWindow(30), "plus");
  assert.equal(planWithWindow(90), "pro");
  assert.equal(planName("free"), "Hobby");
  assert.equal(planLabel(org), "Pro");
  assert.equal(fullAgentHealthPlanName(), "Plus");
  composition.entitlements = {
    ...previous,
    plans: { ...plans, withFullAgentHealth: undefined },
  };
  assert.equal(fullAgentHealthPlanName(), null, "a catalog from an older edition names no plan");
});
