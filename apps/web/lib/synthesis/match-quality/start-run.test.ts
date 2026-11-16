import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrgLimitView } from "@/lib/platform/entitlements";
import type { MatchQualityRunRow } from "@/lib/synthesis/match-quality/schema";
import { type ManualRunDeps, startManualRun } from "./start-run";

/**
 * The manual run the console's button and MCP's `run_quality_analysis` share:
 * the plan check comes before any read, a missing source starts nothing, a live
 * run is a no-op, and the queued job carries the window and the run's id.
 */
const NOW = new Date("2026-11-05T12:00:00.000Z");
const project = { id: "p-1", name: "Support bot" };

/**
 * Owned: upstream reads Free and Pro from its plan tables. This edition has no plans, so the
 * same limits arrive as `limitOverrides`, which the entitlements port still applies.
 */
const PLAN_LIMITS: Record<string, Record<string, number>> = {
  free: {
    matchQualityRunsPerMonth: 0,
    agentHealthSignalsShown: 3,
    agentHealthEvidenceTurns: 0,
    agentHealthWindowDays: 7,
  },
  plus: {
    matchQualityRunsPerMonth: 0,
    agentHealthEvidenceTurns: 3,
    agentHealthWindowDays: 30,
  },
  pro: { matchQualityRunsPerMonth: 4 },
};

function organization(plan: string): OrgLimitView {
  return {
    plan: "free",
    planOverride: plan,
    subscriptionStatus: null,
    limitOverrides: PLAN_LIMITS[plan] ?? null,
  } as unknown as OrgLimitView;
}

function deps(overrides: Partial<ManualRunDeps> = {}, enqueued: unknown[] = []): ManualRunDeps {
  return {
    countRunsSince: async () => 1,
    resolveEvidenceSource: async () => ({ experimentName: "shadow-1", count: 40 }),
    startRun: async (input) => ({ id: "run-1", ...input }) as unknown as MatchQualityRunRow,
    enqueue: async (_projectId, _kind, payload) => {
      enqueued.push(payload);
      return { status: 202, body: { jobId: "job-1" } };
    },
    now: () => NOW,
    ...overrides,
  };
}

test("starts a run and queues its job over the chosen window", async () => {
  const enqueued: unknown[] = [];
  const outcome = await startManualRun(
    { project, organization: organization("pro"), windowDaysRaw: 14 },
    deps({}, enqueued),
  );
  assert.equal(outcome.ok && outcome.status, "started");
  if (!outcome.ok || outcome.status !== "started") return;
  assert.equal(outcome.jobId, "job-1");
  assert.equal(outcome.windowDays, 14);
  assert.equal(outcome.access.remaining, 3);
  const payload = enqueued[0] as Record<string, unknown>;
  assert.equal(payload.runId, "run-1");
  assert.equal(payload.projectName, "Support bot");
  assert.equal(payload.experimentName, "shadow-1");
  assert.equal(payload.windowStart, new Date(NOW.getTime() - 14 * 86_400_000).toISOString());
});

test("a spent allowance refuses before reading anything else", async () => {
  let read = false;
  const outcome = await startManualRun(
    { project, organization: organization("pro"), windowDaysRaw: 7 },
    deps({
      countRunsSince: async () => 4,
      resolveEvidenceSource: async () => {
        read = true;
        return null;
      },
    }),
  );
  assert.equal(!outcome.ok && outcome.reason, "quota");
  assert.equal(read, false);
});

test("a plan without match quality is refused", async () => {
  const outcome = await startManualRun(
    { project, organization: organization("plus"), windowDaysRaw: 7 },
    deps(),
  );
  assert.equal(!outcome.ok && outcome.reason, "quota");
  assert.equal(!outcome.ok && outcome.reason === "quota" && outcome.access.reason, "not_on_plan");
});

test("no recorded searches starts nothing", async () => {
  let started = false;
  const outcome = await startManualRun(
    { project, organization: organization("pro"), windowDaysRaw: 7 },
    deps({
      resolveEvidenceSource: async () => null,
      startRun: async () => {
        started = true;
        return null;
      },
    }),
  );
  assert.equal(!outcome.ok && outcome.reason, "no_source");
  assert.equal(started, false);
});

test("a run already live is a no-op, and queues nothing", async () => {
  const enqueued: unknown[] = [];
  const outcome = await startManualRun(
    { project, organization: organization("pro"), windowDaysRaw: 7 },
    deps({ startRun: async () => null }, enqueued),
  );
  assert.equal(outcome.ok && outcome.status, "already_running");
  assert.equal(enqueued.length, 0);
});

test("a rejected enqueue is a failure", async () => {
  const outcome = await startManualRun(
    { project, organization: organization("pro"), windowDaysRaw: 7 },
    deps({ enqueue: async () => ({ status: 500, body: {} }) }),
  );
  assert.equal(!outcome.ok && outcome.reason, "enqueue_failed");
});
