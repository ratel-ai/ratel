import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { composition } from "@/lib/composition/ports";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { standInModels } from "@/lib/views/eval-gate/models";
import { evalNightlySettings, evalRuns } from "@/lib/views/evals/schema";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import { runEvalSetJob } from "../job";
import {
  enqueueDueNightlyEvalRuns,
  NIGHTLY_ACTOR,
  NIGHTLY_ADMIN_ERROR,
  NIGHTLY_CAP_ERROR,
  NIGHTLY_PAID_ERROR,
  type SetNightlyDeps,
  setNightlyEvals,
} from "../nightly";

/**
 * Owned (ADR-0030): the core has no plan columns; the organization's plan is the entitlements
 * port's. A stand-in port reads it from `orgPlan`, which setup sets and a test changes when the
 * organization leaves the paid plan (upstream cancels its subscription row).
 */
let orgPlan = "pro";
composition.entitlements = { ...composition.entitlements, planId: () => orgPlan };

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const FLAGS_OFF: OrganizationFlagDeps = { ...FLAGS_ON, evaluate: async () => false };
const NOON = new Date("2026-11-08T12:00:00Z");

test("toggle: an admin on a paid plan turns nightly runs on and off, and each change is tracked", async () => {
  const { client, db, toggle, tracked } = await setup();
  try {
    assert.equal(
      (await db.select().from(evalNightlySettings)).length,
      0,
      "Off by default: no row.",
    );
    const on = await setNightlyEvals(PROJECT, true, toggle);
    assert.ok(on.ok, on.ok ? "" : on.error);
    assert.deepEqual([on.value.enabled, on.value.setBy], [true, "user_1"]);
    const off = await setNightlyEvals(PROJECT, false, toggle);
    assert.ok(off.ok);
    assert.equal(off.value.enabled, false);
    const [row] = await db.select().from(evalNightlySettings);
    assert.deepEqual([row!.enabled, row!.setBy], [false, "user_1"]);
    assert.deepEqual(tracked, [true, false]);
  } finally {
    await client.close();
  }
});

test("toggle: a member, a free plan and a flag-off organization are refused and nothing is stored", async () => {
  const member = await setup({ role: "member" });
  try {
    assert.deepEqual(await setNightlyEvals(PROJECT, true, member.toggle), {
      ok: false,
      error: NIGHTLY_ADMIN_ERROR,
    });
  } finally {
    await member.client.close();
  }
  const free = await setup({ plan: "free" });
  try {
    assert.deepEqual(await setNightlyEvals(PROJECT, true, free.toggle), {
      ok: false,
      error: NIGHTLY_PAID_ERROR,
    });
    assert.equal((await free.db.select().from(evalNightlySettings)).length, 0);
    assert.equal(free.tracked.length, 0);
  } finally {
    await free.client.close();
  }
  const flagOff = await setup({ flags: FLAGS_OFF });
  try {
    assert.deepEqual(await setNightlyEvals(PROJECT, true, flagOff.toggle), {
      ok: false,
      error: "Evals are off for this organization.",
    });
  } finally {
    await flagOff.client.close();
  }
});

test("sweep: queues one nightly run per project per UTC day, and none when the setting is off", async () => {
  const { client, db } = await setup();
  try {
    await seedEvals(db);
    const sweep = (now: Date) =>
      enqueueDueNightlyEvalRuns({ db, flagDeps: FLAGS_ON, now: () => now });
    assert.deepEqual(await sweep(NOON), { enqueued: 0 }, "Off by default.");
    await enableNightly(db);
    assert.deepEqual(await sweep(NOON), { enqueued: 1 });
    assert.deepEqual(
      await sweep(new Date("2026-11-08T23:59:00Z")),
      { enqueued: 0 },
      "Same day: not due.",
    );
    const runs = await db.select().from(evalRuns);
    assert.deepEqual(
      runs.map((run) => [run.kind, run.createdBy, run.evalCount]),
      [["nightly", NIGHTLY_ACTOR, 3]],
    );
    assert.deepEqual(
      (await db.select().from(jobs)).map((job) => [
        job.kind,
        (job.payload as { runId: string }).runId,
      ]),
      [["run_eval_set", runs[0]!.id]],
    );
    await db.update(evalRuns).set({ createdAt: new Date("2026-11-08T00:10:00Z") });
    assert.deepEqual(
      await sweep(new Date("2026-11-09T00:01:00Z")),
      { enqueued: 1 },
      "Next day: due again.",
    );
  } finally {
    await client.close();
  }
});

test("sweep: a project that left the paid plan, or whose organization has Evals off, gets no nightly run", async () => {
  const { client, db } = await setup();
  try {
    await seedEvals(db);
    await enableNightly(db);
    assert.deepEqual(
      await enqueueDueNightlyEvalRuns({ db, flagDeps: FLAGS_OFF, now: () => NOON }),
      { enqueued: 0 },
    );
    orgPlan = "free";
    assert.deepEqual(await enqueueDueNightlyEvalRuns({ db, flagDeps: FLAGS_ON, now: () => NOON }), {
      enqueued: 0,
    });
    assert.equal((await db.select().from(evalRuns)).length, 0);
  } finally {
    await client.close();
  }
});

test("job: a nightly run with no daily cap left stops before any model call and records why", async () => {
  const { client, db } = await setup();
  try {
    await seedEvals(db);
    await enableNightly(db);
    // Spent earlier today by the organization: all 10 of the 10 a day.
    await db.insert(evalRuns).values({
      projectId: PROJECT,
      kind: "manual",
      status: "completed",
      createdBy: "t",
      spend: { usd: 10, reservedUsd: 10, reserved: false },
      finishedAt: NOON,
    });
    await enqueueDueNightlyEvalRuns({ db, flagDeps: FLAGS_ON, now: () => NOON });
    const [nightly] = await db.select().from(evalRuns).where(eq(evalRuns.kind, "nightly"));
    let replays = 0;
    const result = await runEvalSetJob(
      PROJECT,
      { runId: nightly!.id },
      {
        db,
        flagDeps: FLAGS_ON,
        models: standInModels(),
        observability: { trackSystemEvent: async () => undefined },
        now: () => NOON,
        loadReplays: async () => {
          replays++;
          return new Map();
        },
      },
    );
    assert.deepEqual(result, { ran: false, reason: "cap" });
    assert.equal(replays, 0);
    const run = (await createDrizzleEvalStore(db).getRun(PROJECT, nightly!.id))!;
    assert.deepEqual(
      [run.status, run.error, run.spend.reserved],
      ["failed", NIGHTLY_CAP_ERROR, false],
    );
  } finally {
    await client.close();
  }
});

test("job: a nightly run never holds more than the project's nightly cap for the day", async () => {
  const { client, db } = await setup();
  try {
    await seedEvals(db);
    await enableNightly(db);
    await enqueueDueNightlyEvalRuns({ db, flagDeps: FLAGS_ON, now: () => NOON });
    const [nightly] = await db.select().from(evalRuns);
    await runEvalSetJob(
      PROJECT,
      { runId: nightly!.id },
      {
        db,
        flagDeps: FLAGS_ON,
        models: standInModels(),
        observability: { trackSystemEvent: async () => undefined },
        now: () => NOON,
        runBudgetUsd: 5,
        nightlyBudgetUsd: 0.25,
        loadReplays: async () => new Map(),
      },
    );
    const run = (await createDrizzleEvalStore(db).getRun(PROJECT, nightly!.id))!;
    assert.equal(run.status, "completed");
    assert.equal(run.spend.reservedUsd, 0.25);
  } finally {
    await client.close();
  }
});

test("job: a queued nightly run of a project that left the paid plan does not run", async () => {
  const { client, db } = await setup();
  try {
    await seedEvals(db);
    await enableNightly(db);
    await enqueueDueNightlyEvalRuns({ db, flagDeps: FLAGS_ON, now: () => NOON });
    orgPlan = "free";
    const [nightly] = await db.select().from(evalRuns);
    const result = await runEvalSetJob(
      PROJECT,
      { runId: nightly!.id },
      {
        db,
        flagDeps: FLAGS_ON,
        models: standInModels(),
        now: () => NOON,
        loadReplays: async () => new Map(),
      },
    );
    assert.deepEqual(result, { ran: false, reason: "not_paid" });
    const run = (await createDrizzleEvalStore(db).getRun(PROJECT, nightly!.id))!;
    assert.deepEqual([run.status, run.error], ["failed", NIGHTLY_PAID_ERROR]);
  } finally {
    await client.close();
  }
});

/* - fixtures ---------------------------------------------------------------- */

async function setup({
  plan = "pro",
  role = "admin",
  flags = FLAGS_ON,
}: {
  plan?: string;
  role?: string;
  flags?: OrganizationFlagDeps;
} = {}) {
  orgPlan = plan;
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const tracked: boolean[] = [];
  const toggle: SetNightlyDeps = {
    db,
    flagDeps: flags,
    now: () => NOON,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) => {
      const [organization] = await db.select().from(organizations).where(eq(organizations.id, ORG));
      return { project: { id: projectId }, organization: organization!, role };
    },
    track: async (event) => {
      tracked.push(event.enabled);
    },
  };
  return { client, db, toggle, tracked };
}

async function enableNightly(db: ReturnType<typeof getDb>) {
  await db
    .insert(evalNightlySettings)
    .values({ projectId: PROJECT, enabled: true, setBy: "user_1" });
}

async function seedEvals(db: ReturnType<typeof getDb>) {
  const store = createDrizzleEvalStore(db);
  const base = {
    projectId: PROJECT,
    message: "Pick seat 23A on R1",
    origin: "user" as const,
    createdBy: "t",
    tasks: ["wf-1"],
  };
  await store.createEval({ ...base, name: "One", status: "approved" });
  await store.createEval({ ...base, name: "Two", status: "approved" });
  await store.createEval({ ...base, name: "Suggested", status: "suggested" });
  await store.createEval({ ...base, name: "Removed", status: "archived" });
}
