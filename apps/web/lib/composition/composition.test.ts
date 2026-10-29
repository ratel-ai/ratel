import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompositionPorts } from "@/lib/contracts/composition";

process.env.RATEL_COMPOSITION = "oss";
const { createComposition } = await import("@/lib/composition");
const { drainSteps, jobHandlers } = await import("@/lib/composition/registry");
const { scanEeBoundary } = await import("../../../../scripts/check-ee-boundary.mjs");

/** Stand-in commercial ports so tests do not reach into ee/ through the core tree. */
const cloudPorts: CompositionPorts = {
  session: {
    async resolvePrincipal() {
      return {
        id: "user_cloud",
        email: "fausto@ratel.sh",
        emailVerified: true,
        name: "Fausto",
        username: "fausto",
        avatarUrl: null,
      };
    },
    async accessGranted() {
      return false;
    },
    async actingAs() {
      return { kind: "organization", targetId: "org_1", readOnly: true };
    },
  },
  entitlements: {
    planId: () => "pro",
    getLimits: () => ({
      maxProjects: 10,
      maxSkillsPerProject: 1000,
      maxMembers: 25,
      monthlyEventLimit: 5_000_000,
      embeddingMonthlyAllowanceUsd: 20,
      matchQualityRunsPerMonth: 4,
      agentHealthSignalsShown: Number.POSITIVE_INFINITY,
      agentHealthEvidenceTurns: 6,
      agentHealthWindowDays: 90,
      toolPickerMonthlyAllowanceUsd: 40,
    }),
    checkQuota: () => ({ ok: true }),
    checkMeteredFeature: () => ({ ok: true, limit: 4, used: 0, remaining: 4 }),
    async checkEventQuota() {
      return {
        ok: false,
        plan: "pro",
        limit: 5_000_000,
        used: 5_000_000,
        message: "Monthly event limit reached for your plan.",
      };
    },
    async recordEventUsage() {},
  },
  telemetry: {
    async trackEvent() {},
    reportException() {},
  },
  embeddingProvider: {
    model: "hosted",
    local: false,
    isAvailable: () => true,
    async embed(texts) {
      return texts.map(() => [1]);
    },
  },
  registry: {
    registrations: () => [
      {
        jobs: { grant_allowances: async () => "granted" },
        drainSteps: [{ name: "stripe_sync", phase: "after", run: async () => 1 }],
      },
    ],
  },
};

describe("createComposition", () => {
  it("assembles the OSS edition with the five ports", async () => {
    const composition = createComposition("oss");
    assert.equal(composition.edition, "Ratel OSS");
    const principal = await composition.session.resolvePrincipal();
    assert.ok(principal);
    assert.equal(principal.name, "Local operator");
    assert.equal(await composition.session.accessGranted(principal), true);
    assert.equal(await composition.session.actingAs(), null);
    assert.equal(composition.entitlements.planId({ id: "org" }), "oss");
    assert.deepEqual(await composition.entitlements.checkEventQuota({ id: "org" }), { ok: true });
    assert.equal(composition.embeddingProvider.local, true);
    assert.deepEqual(composition.registry.registrations(), []);
  });

  it("assembles the Cloud edition from the seam", async () => {
    const composition = createComposition("cloud", { eeComposition: cloudPorts });
    assert.equal(composition.edition, "Ratel Cloud");
    assert.equal(composition.entitlements.planId({ id: "org" }), "pro");
    const quota = await composition.entitlements.checkEventQuota({ id: "org" });
    assert.equal(quota.ok, false);
    if (!quota.ok) assert.equal(quota.used, 5_000_000);
    await composition.entitlements.recordEventUsage({ id: "org" }, 12);
    const actingAs = await composition.session.actingAs();
    assert.equal(actingAs?.kind, "organization");
  });

  it("throws when a port is missing or the edition key is unknown", () => {
    assert.throws(
      () => createComposition("oss", { ports: { telemetry: undefined } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /telemetry/);
        return true;
      },
    );
    assert.throws(
      () => createComposition("nope"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /RATEL_COMPOSITION/);
        assert.match(error.message, /oss/);
        assert.match(error.message, /cloud/);
        return true;
      },
    );
  });

  it("supplies nav for Cloud and an empty nav for OSS", () => {
    assert.deepEqual(createComposition("oss").nav, []);
    const cloud = createComposition("cloud", { eeComposition: cloudPorts });
    assert.equal(cloud.nav.length, 1);
    assert.equal(cloud.nav[0].href, "/admin");
  });

  it("throws when cloud is requested but the seam is null", () => {
    assert.throws(
      () => createComposition("cloud", { eeComposition: null }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /excludes the commercial modules/);
        return true;
      },
    );
  });

  it("reports zero ee boundary violations on the real tree", () => {
    assert.deepEqual(scanEeBoundary(), []);
  });
});

describe("registry root", () => {
  it("merges core and port registrations, before steps first", () => {
    const core = [
      {
        jobs: { cluster_intents: async () => "ok" },
        drainSteps: [
          { name: "prune_spans", phase: "after" as const, retentionOnly: true, run: async () => 0 },
          { name: "enqueue_folds", phase: "before" as const, run: async () => 1 },
        ],
      },
    ];
    const registrations = [...core, ...cloudPorts.registry.registrations()];
    assert.deepEqual(Object.keys(jobHandlers(registrations)).sort(), [
      "cluster_intents",
      "grant_allowances",
    ]);
    assert.deepEqual(
      drainSteps(registrations).map((s) => s.name),
      ["enqueue_folds", "prune_spans", "stripe_sync"],
    );
  });

  it("the core modules landed so far register their jobs and steps in layer order", () => {
    assert.deepEqual(Object.keys(jobHandlers()).sort(), ["build_trace_turns"]);
    assert.deepEqual(
      drainSteps().map((s) => `${s.phase}:${s.name}${s.retentionOnly ? ":retention" : ""}`),
      [
        "before:trace_turns_build_enqueue",
        "after:runtime_events_prune:retention",
        "after:runtime_event_rejects_prune:retention",
      ],
    );
  });

  it("refuses a job kind or drain step registered twice", () => {
    const twice = [{ jobs: { a: async () => 1 } }, { jobs: { a: async () => 2 } }];
    assert.throws(() => jobHandlers(twice), /job kind registered twice: a/);
    const steps = [
      { drainSteps: [{ name: "s", phase: "before" as const, run: async () => 1 }] },
      { drainSteps: [{ name: "s", phase: "after" as const, run: async () => 1 }] },
    ];
    assert.throws(() => drainSteps(steps), /drain step registered twice: s/);
  });
});
