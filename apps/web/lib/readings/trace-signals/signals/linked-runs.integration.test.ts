import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { turn } from "@/lib/ledger/test-support";
import { loadAnalysisContext } from "@/lib/readings/trace-signals/signals/analysis-context";
import {
  type ComputeDeps,
  computeSignals,
  signalWindow,
} from "@/lib/readings/trace-signals/signals/compute";
import {
  type Db,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { linkRunsPage } from "@/lib/readings/trace-signals/signals/linked-runs-query";
import { times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Linking SDK runs to OpenTelemetry model calls over a real schema: a project
 * whose agent sends both (same session id) plus a second, OTel-only agent.
 * The SDK runs gain model calls and cost, each model call counts once, and
 * SDK-only and OTel-only projects read exactly as they did.
 */

const END = new Date("2026-09-02T00:00:00Z");
const MENU = JSON.stringify(["find_task", "assign_task", "archive_board"]);

async function insertModelCall(
  client: PGlite,
  opts: { session: string; trace: string; at: number; n: number; prompt?: string },
) {
  const payload = JSON.stringify({
    type: "otlp_model_call",
    derived_from: "otlp",
    model: "claude-sonnet-4-6",
    menu: JSON.parse(MENU),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
  });
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, ingest_source, client_event_id,
       trace_id, took_ms, input_tokens, output_tokens, payload)
     values (gen_random_uuid(), $1, 'otlp_model_call', $2, $3, $3, 'otlp', $4, $5, 800, 2000, 200, $6::jsonb)`,
    [
      PROJECT_ID,
      opts.session,
      new Date(opts.at).toISOString(),
      `otlp:model:${opts.trace}:${opts.n}`,
      opts.trace,
      payload,
    ],
  );
}

/** Ten SDK runs whose agent also sends three model calls each (same session). */
async function seedSdkWithModelCalls(client: PGlite, db: Db) {
  const fixtures = times(10, (i) =>
    turn({ session: `both-${i}`, turnId: `t-${i}` })
      .search(["find_task"], { query: "find the task" })
      .invoke("find_task")
      .invoke("assign_task"),
  );
  await seedLedger(client, db, fixtures);
  for (const [i, fixture] of fixtures.entries()) {
    const start = fixture.rows()[0]!.occurredAt!.getTime();
    for (let n = 0; n < 3; n++) {
      await insertModelCall(client, {
        session: `both-${i}`,
        trace: `both-trace-${i}`,
        at: start - 1_000 + n * 1_500,
        n,
        prompt: n === 0 ? "assign the Falcon bug to Ada" : undefined,
      });
    }
  }
}

/** Eight runs of a second agent that sends only OpenTelemetry, in sessions of its own. */
async function seedOtelAgent(client: PGlite, db: Db) {
  const fixtures = times(8, (i) =>
    turn({ lane: "otlp", traceId: `solo-${i}`, session: `solo-${i}` })
      .end("find_task")
      .end("archive_board"),
  );
  await seedLedger(client, db, fixtures);
  await client.exec(
    `update trace_events set ingest_source = 'otlp', payload = '{"derived_from":"otlp"}'::jsonb where session_id like 'solo-%'`,
  );
  for (const [i, fixture] of fixtures.entries()) {
    const at = fixture.rows()[0]!.occurredAt!.getTime();
    for (let n = 0; n < 2; n++)
      await insertModelCall(client, { session: `solo-${i}`, trace: `solo-${i}`, at: at + n, n });
  }
}

function deps(db: Db, over: Partial<ComputeDeps> = {}): Partial<ComputeDeps> {
  return {
    listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
    loadContext: (p, w) => loadAnalysisContext(p, w, db),
    linkPage: (p, turns) => linkRunsPage(p, turns, db),
    ...over,
  };
}

const unlinked = async (_p: string, turns: readonly SignalTurn[]) => [...turns];

test("SDK runs of an agent that also sends OpenTelemetry gain model calls, cost and the menu", async () => {
  const { client, db } = await setupDb();
  await seedSdkWithModelCalls(client, db);
  await seedOtelAgent(client, db);
  const { result } = await computeSignals(PROJECT_ID, signalWindow(END, 7), deps(db));

  assert.deepEqual(result.linking, { sdkRuns: 10, linkedRuns: 10 });
  const linked = result.summary.daily.reduce(
    (sum, day) => ({
      runs: sum.runs + (day.linked?.runs ?? 0),
      calls: sum.calls + (day.linked?.modelCalls ?? 0),
      usd: sum.usd + (day.linked?.costUsd ?? 0),
    }),
    { runs: 0, calls: 0, usd: 0 },
  );
  assert.equal(linked.runs, 10);
  assert.equal(linked.calls, 30, "each model call counts once, the OTel-only agent's never");
  // 2,000 in at $3/M plus 200 out at $15/M is $0.009 a call.
  assert.equal(Math.round(linked.usd * 1e6) / 1e6, 0.27);
  assert.equal(result.turnSourceMix.otlp, 8, "the OTel-only agent keeps its runs");
  const unused = result.signals.find((s) => s.kind === "unused_tool");
  assert.ok(result.measured.has("long_turn"));
  assert.ok(result.measured.has("unused_tool"));
  assert.equal(
    unused,
    undefined,
    "archive_board is called by the OTel-only agent, so it is not unused",
  );
  await client.close();
});

test("an SDK-only project never reads for links and stores exactly what it did", async () => {
  const { client, db } = await setupDb();
  const fixtures = times(10, (i) =>
    turn({ session: `sdk-${i}` })
      .search(["find_task"])
      .invoke("find_task"),
  );
  await seedLedger(client, db, fixtures);
  let reads = 0;
  const counted = deps(db, {
    linkPage: async (_p, turns) => {
      reads += 1;
      return [...turns];
    },
  });
  const linked = await computeSignals(PROJECT_ID, signalWindow(END, 7), counted);
  const plain = await computeSignals(
    PROJECT_ID,
    signalWindow(END, 7),
    deps(db, { linkPage: unlinked }),
  );
  assert.equal(reads, 0, "no model calls in the window, no link read");
  assert.deepEqual(linked.result.linking, { sdkRuns: 10, linkedRuns: 0 });
  assert.equal(JSON.stringify(linked.result.summary), JSON.stringify(plain.result.summary));
  assert.equal(JSON.stringify(linked.result.signals), JSON.stringify(plain.result.signals));
  assert.equal(
    linked.result.summary.daily.some((day) => "linked" in day),
    false,
  );
  await client.close();
});

test("an OpenTelemetry-only project reads exactly as it did", async () => {
  const { client, db } = await setupDb();
  await seedOtelAgent(client, db);
  const linked = await computeSignals(PROJECT_ID, signalWindow(END, 7), deps(db));
  const plain = await computeSignals(
    PROJECT_ID,
    signalWindow(END, 7),
    deps(db, { linkPage: unlinked }),
  );
  assert.equal(JSON.stringify(linked.result.summary), JSON.stringify(plain.result.summary));
  assert.equal(JSON.stringify(linked.result.signals), JSON.stringify(plain.result.signals));
  assert.deepEqual(linked.result.linking, { sdkRuns: 0, linkedRuns: 0 });
  await client.close();
});

test("SDK runs whose events carry the OTel trace id link to that trace's model calls, whatever their session", async () => {
  const { client, db } = await setupDb();
  // The OTel exporter sets no conversation id: its model calls' session is the trace id.
  const fixtures = times(6, (i) =>
    turn({ session: `sdk-${i}`, turnId: `t-${i}`, traceId: `${i}`.padStart(32, "a") })
      .search(["find_task"], { query: "find the task" })
      .invoke("find_task"),
  );
  await seedLedger(client, db, fixtures);
  for (const [i, fixture] of fixtures.entries()) {
    const start = fixture.rows()[0]!.occurredAt!.getTime();
    const trace = `${i}`.padStart(32, "a");
    for (let n = 0; n < 2; n++)
      await insertModelCall(client, { session: trace, trace, at: start + n * 500, n });
  }
  const { result } = await computeSignals(PROJECT_ID, signalWindow(END, 7), deps(db));
  assert.deepEqual(result.linking, { sdkRuns: 6, linkedRuns: 6 });
  const calls = result.summary.daily.reduce((sum, day) => sum + (day.linked?.modelCalls ?? 0), 0);
  assert.equal(calls, 12);

  await client.close();
});
