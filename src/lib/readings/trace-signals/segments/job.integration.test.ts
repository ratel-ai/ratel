import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveSteps } from "@/lib/ingest/otlp/derive-steps";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import { writeTurnPage } from "@/lib/ledger/turns/queries";
import type { TurnEventRow } from "@/lib/ledger/types";
import { computeProjectTraceSignals } from "../signals/compute-job";
import { jobDeps, PROJECT_ID, setupDb } from "../signals/integration-support";

test("ten Stema fixtures form one model/code task and the job writes stable segments", async () => {
  const { client, db } = await setupDb();
  const start = Date.parse("2026-09-10T12:00:00Z");
  const now = new Date("2026-09-14T00:00:00Z");
  for (let n = 0; n < 10; n++) {
    const spans = typedStepFixtures(start + n * 60_000).stema.map((s) => ({
      ...s,
      traceId: (100 + n).toString(16).padStart(32, "0"),
    }));
    const rows = [...deriveSteps(spans), ...deriveModelCalls(spans)].map((row) => ({
      ...row,
      id: randomUUID(),
      receivedAt: row.occurredAt ?? now,
      failed: row.errorMessage !== null,
    }));
    const events = normalizeEvents(rows as unknown as TurnEventRow[], new Map(), { salt: "test" });
    const { turns } = buildTurns({ stored: [], events, now });
    await writeTurnPage(
      { projectId: PROJECT_ID, turns, orphanedTurnIds: [], through: now.toISOString(), now },
      db,
    );
  }
  assert.equal(
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from trace_turns where status='closed'`,
      )
    ).rows[0]!.n,
    10,
  );
  const deps = jobDeps(db, now, []);
  const first = await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, deps);
  assert.equal(first.outcome, "completed");
  const read = async () =>
    (
      await client.query<{ id: string; workflow_id: string }>(
        `select id,workflow_id from task_segments order by id`,
      )
    ).rows;
  const before = await read();
  assert.equal(before.length, 10);
  assert.equal(new Set(before.map((s) => s.workflow_id)).size, 1);
  const { rows } = await client.query<{
    summary: { workflows: { items: { coreTools: string[] }[] } };
  }>(`select summary from trace_signal_runs order by created_at desc limit 1`);
  const tasks = rows[0]!.summary.workflows.items;
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0]!.coreTools.includes("code:prepare_response"));
  assert.ok(tasks[0]!.coreTools.some((t) => t.startsWith("model:")));
  assert.equal(
    (await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, deps)).outcome,
    "completed",
  );
  assert.deepEqual(await read(), before);
  await client.close();
});
