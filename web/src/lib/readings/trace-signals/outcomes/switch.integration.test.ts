import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { resolveConfig } from "@/config";
import { sentimentQuestionsEnabled } from "@/lib/readings/trace-signals/outcomes/questions-gate";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  ORGANIZATION_ID,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";

/**
 * The signal run behind the core's `sentimentAnalysis` switch (ADR-0004; not an upstream file:
 * upstream reads outcomes with every run). With `FF_SENTIMENT_ANALYSIS` unset the run writes no
 * row to the three outcome tables and leaves no outcomes in its summary; set, it writes them.
 */

const BASE = Date.parse("2026-09-10T08:00:00Z");
const NOW = new Date("2026-09-11T08:00:00Z");
const TABLES = ["trace_turn_outcomes", "trace_session_outcomes", "trace_task_outcomes"] as const;

/** 12 sessions of one run each: half fail once and recover, half are clean. */
function fixtures() {
  return times(12, (i) => {
    const run = fresh({ session: `s-${i.toString().padStart(2, "0")}`, start: BASE + i * 60_000 });
    return i < 6
      ? run.invoke("find_task").invoke("update_task").error("update_task").invoke("update_task")
      : run.invoke("find_task").invoke("update_task");
  });
}

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  return { client, db };
}

/** The switch as the job reads it, for a deployment with this environment and no edition. */
const switchFor = (env: Record<string, string>) => (projectId: string) =>
  sentimentQuestionsEnabled(projectId, {
    getOrganization: async () => ({ id: ORGANIZATION_ID }),
    flags: { config: resolveConfig({ env }), edition: "Ratel OSS", port: undefined },
  });

async function rowCounts(client: PGlite): Promise<number[]> {
  return Promise.all(
    TABLES.map((table) => count(client, `select count(*)::int as n from ${table}`)),
  );
}

test("FF_SENTIMENT_ANALYSIS unset: the run completes and writes no outcome row", async () => {
  const { client, db } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], { outcomesEnabled: switchFor({}) }),
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(await rowCounts(client), [0, 0, 0]);
  const run = await latestSignalRun(PROJECT_ID, db);
  assert.equal("outcomes" in ((run?.summary ?? {}) as object), false);
});

test("FF_SENTIMENT_ANALYSIS=0 is off too, and a switch that cannot be read is off", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], { outcomesEnabled: switchFor({ FF_SENTIMENT_ANALYSIS: "0" }) }),
  );
  assert.deepEqual(await rowCounts(client), [0, 0, 0]);
  const failing = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 60_000), [], {
      outcomesEnabled: async () => {
        throw new Error("flags down");
      },
    }),
  );
  assert.equal(failing.outcome, "completed");
  assert.deepEqual(await rowCounts(client), [0, 0, 0]);
});

test("FF_SENTIMENT_ANALYSIS=1: the run writes a row per turn, per session and per task", async () => {
  const { client, db } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], { outcomesEnabled: switchFor({ FF_SENTIMENT_ANALYSIS: "1" }) }),
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(await rowCounts(client), [12, 12, 12]);
  const run = await latestSignalRun(PROJECT_ID, db);
  const outcomes = (run?.summary as { outcomes?: { turns: number; sessions: number } }).outcomes;
  assert.deepEqual([outcomes?.turns, outcomes?.sessions], [12, 12]);
  // The open-source edition has no question engine: every row is the rules'.
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_turn_outcomes where result_source <> 'rule' or model_version is not null`,
    ),
    0,
  );
});
