import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { buildProjectTraceTurns } from "@/lib/ledger/turns/build-job";
import type { ReloadReach } from "@/lib/ledger/turns/build-turn";
import {
  type BuildJobRequest,
  closeIdleTraceTurns,
  enqueueBuildTraceTurnsJob,
  getTraceTurnsCursor,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import { type Db, PROJECT_ID, setupDb } from "./integration-support";
import { enqueueComputeJob, type RunTrigger } from "./queries";

/**
 * The ledger's `enqueueReading` seam, as this reading fills it: a build that carries a
 * reading request (the page's "read now") enqueues the signal run once it has caught up,
 * and the run's enqueue coalesces like every other. The first-reading seam
 * (`onBacklogDrained`) has its own cases in `compute-job.integration.test.ts`.
 */

let seq = 0;
function envelope(body: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    v: 2,
    ts: Date.now() - 60 * 60_000 + seq * 1_000,
    session_id: "sess-a",
    source_id: "app",
    event_id: `evt-${seq}`,
    ...body,
  };
}

async function ingest(db: Db, events: Record<string, unknown>[]): Promise<void> {
  const { valid } = parseTraceEvents(events);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" as const })),
    db,
  );
}

function buildDeps(db: Db) {
  return {
    getCursor: (p: string) => getTraceTurnsCursor(p, db),
    listEvents: (p: string, since: Date | string, _db: unknown, limit?: number) =>
      listTurnEventsPage(p, since, db, limit),
    listHits: (ids: readonly string[]) => listTurnEventHits(ids, db),
    loadTurns: (p: string, s: readonly string[], k: readonly string[], reach: ReloadReach | null) =>
      loadReloadableTurns(p, s, k, reach, db),
    writePage: (input: Parameters<typeof writeTurnPage>[0]) => writeTurnPage(input, db),
    closeIdle: (p: string, before: Date, now: Date) => closeIdleTraceTurns(p, before, now, db),
    enqueueBuild: (p: string, request?: BuildJobRequest) =>
      enqueueBuildTraceTurnsJob(p, db, request),
    // The seam, bound to this database as the registration binds it to the real one.
    enqueueReading: (p: string, trigger: RunTrigger) => enqueueComputeJob(p, trigger, db),
    onBacklogDrained: async () => undefined,
    observability: { trackSystemEvent: async () => undefined },
    salt: "test-salt",
  };
}

test("a build carrying a reading request enqueues the run once caught up, and a second request coalesces", async () => {
  const { client, db } = await setupDb();
  await ingest(db, [
    envelope({
      type: "search",
      query: "find the task",
      origin: "agent",
      top_k: 1,
      hits: [{ tool_id: "find_task", score: 0.9 }],
    }),
    envelope({ type: "invoke_start", tool_id: "find_task", invocation_id: "inv-1" }),
    envelope({ type: "invoke_end", tool_id: "find_task", invocation_id: "inv-1", took_ms: 40 }),
  ]);
  const queued = async () =>
    (
      await client.query<{ payload: { trigger: string } }>(
        `select payload from jobs where kind = 'compute_trace_signals' and status = 'queued'`,
      )
    ).rows.map((r) => r.payload.trigger);

  const plain = await buildProjectTraceTurns(PROJECT_ID, buildDeps(db));
  assert.equal(plain.readingQueued, false, "a build nobody asked a reading of queues none");
  assert.deepEqual(await queued(), []);

  const asked = await buildProjectTraceTurns(PROJECT_ID, buildDeps(db), { reading: "manual" });
  assert.equal(asked.readingQueued, true);
  assert.deepEqual(await queued(), ["manual"]);

  const again = await buildProjectTraceTurns(PROJECT_ID, buildDeps(db), { reading: "manual" });
  assert.equal(again.readingQueued, false, "one queued run per project");
  assert.deepEqual(await queued(), ["manual"]);
  await client.close();
});
