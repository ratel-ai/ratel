import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { resolveConfig } from "@/config";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import {
  enqueueDueTaskScores,
  enqueueScoreTasksJob,
  scoreTasksJob,
} from "@/lib/views/task-scorers/job";

/**
 * Owned (ADR-0004): upstream turns the gate on per organization through its flag service; here
 * it is one switch for the deployment, `evalGate`. So the refusal cases run with the switch
 * off, and the projects of one organization stand in for upstream's "on" organization.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const OFF_ORG = "44444444-4444-4444-8444-444444444444";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const OFF_PROJECT = "55555555-5555-4555-8555-555555555555";
const QUIET_PROJECT = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-11-01T12:00:00Z");
const GATE_ON: OrganizationFlagDeps = resolveConfig({ override: { flags: { evalGate: true } } });
const GATE_OFF: OrganizationFlagDeps = resolveConfig({ override: { flags: { evalGate: false } } });

interface Seen {
  logs: { message: string; fields: Record<string, unknown> }[];
  events: { event: string; actor: string; fields: Record<string, unknown> }[];
}

test("the daily sweep queues one score job per project with task runs, with no signal run", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, project: PROJECT });
    await seedRun(client, { n: 2, project: PROJECT, task: "task-b" });
    await seedRun(client, { n: 3, project: OTHER_PROJECT });
    await seedRun(client, { n: 4, project: QUIET_PROJECT, day: "2026-10-01" });
    await seedRun(client, { n: 5, project: QUIET_PROJECT, task: null });
    const seen = sink();
    const deps = { db, flagDeps: GATE_ON, now: () => NOW, ...seen.deps };

    assert.deepEqual(await enqueueDueTaskScores(deps), { enqueued: 2, refused: 0 });
    assert.deepEqual(
      await scoreJobs(db),
      [
        { projectId: PROJECT, status: "queued" },
        { projectId: OTHER_PROJECT, status: "queued" },
      ].sort(byProject),
    );
    assert.equal((await db.select().from(traceSignalRuns)).length, 0);

    // Same UTC day, even after the job ran: nothing new.
    await db.update(schema.jobs).set({ status: "done" }).where(eq(schema.jobs.kind, "score_tasks"));
    assert.deepEqual(
      await enqueueDueTaskScores({ ...deps, now: () => new Date("2026-11-01T23:59:00Z") }),
      { enqueued: 0, refused: 0 },
    );

    // The next UTC day: one more each.
    assert.deepEqual(
      await enqueueDueTaskScores({ ...deps, now: () => new Date("2026-11-02T00:01:00Z") }),
      { enqueued: 2, refused: 0 },
    );
    assert.equal((await scoreJobs(db)).length, 4);
  } finally {
    await client.close();
  }
});

test("the daily sweep skips a project whose signal run already queued scoring today", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, project: PROJECT });
    const seen = sink();
    const deps = { db, flagDeps: GATE_ON, now: () => NOW, ...seen.deps };
    assert.ok(await enqueueScoreTasksJob(PROJECT, deps));
    assert.deepEqual(await enqueueDueTaskScores(deps), { enqueued: 0, refused: 0 });
    assert.equal((await scoreJobs(db)).length, 1);
  } finally {
    await client.close();
  }
});

test("a gate refusal in the sweep writes a log line and a task_scores_skipped event once a day", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, project: OFF_PROJECT });
    const seen = sink();
    const deps = { db, flagDeps: GATE_OFF, now: () => NOW, ...seen.deps };

    assert.deepEqual(await enqueueDueTaskScores(deps), { enqueued: 0, refused: 1 });
    assert.deepEqual(seen.logs, [
      {
        message: "skipped task scoring",
        fields: { project_id: OFF_PROJECT, reason: "gate_off", trigger: "daily_sweep" },
      },
    ]);
    assert.deepEqual(seen.events, [
      {
        event: "task_scores_skipped",
        actor: "system:task-scorers",
        fields: {
          object_action: "task_scores_skipped",
          project_id: OFF_PROJECT,
          reason: "gate_off",
          trigger: "daily_sweep",
        },
      },
    ]);
    assert.deepEqual(
      await scoreJobs(db),
      [{ projectId: OFF_PROJECT, status: "done" }],
      "the refusal is recorded, never queued",
    );

    assert.deepEqual(await enqueueDueTaskScores(deps), { enqueued: 0, refused: 0 });
    assert.equal(seen.events.length, 1, "one refusal a day, not one a minute");
  } finally {
    await client.close();
  }
});

test("a gate refusal after a signal run writes a log line and the event", async () => {
  const { client, db } = await setup();
  try {
    const seen = sink();
    assert.equal(
      await enqueueScoreTasksJob(OFF_PROJECT, {
        db,
        flagDeps: GATE_OFF,
        now: () => NOW,
        ...seen.deps,
      }),
      null,
    );
    assert.deepEqual(
      seen.logs.map((log) => [log.message, log.fields.trigger]),
      [["skipped task scoring", "signal_run"]],
    );
    assert.deepEqual(
      seen.events.map((event) => [event.event, event.fields.reason]),
      [["task_scores_skipped", "gate_off"]],
    );
  } finally {
    await client.close();
  }
});

test("a queued job the gate refuses at run time writes a log line and the event", async () => {
  const { client, db } = await setup();
  try {
    const seen = sink();
    assert.deepEqual(
      await scoreTasksJob(OFF_PROJECT, {
        db,
        flagDeps: GATE_OFF,
        now: () => NOW,
        ...seen.deps,
      }),
      { scored: false, reason: "gate_off" },
    );
    assert.deepEqual(
      seen.logs.map((log) => [log.message, log.fields.trigger]),
      [["skipped task scoring", "job"]],
    );
    assert.deepEqual(
      seen.events.map((event) => [event.event, event.fields.trigger]),
      [["task_scores_skipped", "job"]],
    );
  } finally {
    await client.close();
  }
});

function sink() {
  const seen: Seen = { logs: [], events: [] };
  return {
    ...seen,
    deps: {
      logger: {
        info: (fields: Record<string, unknown>, message: string) => {
          seen.logs.push({ message, fields });
        },
      },
      observability: {
        trackSystemEvent: async (event: string, actor: string, fields: Record<string, unknown>) => {
          seen.events.push({ event, actor, fields });
        },
      },
    },
  };
}

async function scoreJobs(db: ReturnType<typeof getDb>) {
  const rows = await db
    .select({ projectId: schema.jobs.projectId, status: schema.jobs.status })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.kind, "score_tasks")));
  return rows.sort(byProject);
}

function byProject(a: { projectId: string }, b: { projectId: string }) {
  return a.projectId.localeCompare(b.projectId);
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test'), ('${OFF_ORG}', 'Off', 'off');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'),
      ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other'),
      ('${QUIET_PROJECT}', '${ORG}', 'Quiet', 'quiet'),
      ('${OFF_PROJECT}', '${OFF_ORG}', 'Off', 'off');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

async function seedRun(
  client: Awaited<ReturnType<typeof setup>>["client"],
  input: {
    n: number;
    project: string;
    day?: string;
    task?: string | null;
  },
) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(input.n).padStart(12, "0")}`;
  const start = new Date(`${input.day ?? "2026-11-01"}T10:00:00Z`);
  const end = new Date(start.getTime() + 1000);
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $6, $6, 'declared', 'runtime', 'closed', $3, $4, $4, $5)`,
    [
      id,
      input.project,
      start.toISOString(),
      end.toISOString(),
      input.task === undefined ? "task-a" : input.task,
      `run-${input.n}`,
    ],
  );
}
