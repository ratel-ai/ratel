import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Deployment,
  drain,
  dumpTables,
  envelopeHandler,
  envelopeOf,
  eventsBody,
  type IngestBody,
  ingestEvents,
  memoryStore,
  PROJECT_ID,
  processEventsDeps,
  SECRET_KEY_ID,
  SHARED_KEY,
  setupDeployment,
  testQueue,
} from "./test-support";

const text = (value: string): IngestBody => ({
  contentType: "application/json",
  bytes: new TextEncoder().encode(value),
});

async function queued(bodies: readonly IngestBody[]): Promise<Deployment> {
  const deployment = await setupDeployment();
  const queue = testQueue();
  await ingestEvents(deployment, bodies, queue);
  await drain(queue, envelopeHandler(deployment), bodies.length);
  return deployment;
}

for (const [label, key] of [
  ["a secret key", undefined],
  ["an append-only key", SHARED_KEY],
] as const) {
  test(`${label}: an envelope stores the same rows and jobs as a direct send`, async () => {
    // Within the five minutes that a fact's time may be behind the clock.
    const at = Date.now() - 60_000;
    for (const bodies of [[eventsBody(at, key)], [eventsBody(at, key), eventsBody(at, key)]]) {
      const direct = await setupDeployment();
      await ingestEvents(direct, bodies);
      const other = await queued(bodies);
      const expected = await dumpTables(direct);
      assert.deepEqual(await dumpTables(other), expected);
      assert.equal(expected.trace_events.length, 6);
      assert.equal(expected.trace_event_rejects.length, 2);
      assert.equal(expected.tool_usage_counters.length, 1);
      assert.equal(expected.runtime_event_sources.length, key ? 0 : 1);
      assert.equal(expected.intent_graph_runtime_status.length, key ? 0 : 1);
      assert.deepEqual(expected.jobs.map((row) => JSON.parse(row).kind).sort(), [
        "build_trace_turns",
        "cluster_intents",
        "fold_intent_graph",
      ]);
      await Promise.all([direct.client.close(), other.client.close()]);
    }
  });
}

test("a failed store is retried and still starts the follow-up jobs", async () => {
  const deployment = await setupDeployment();
  const queue = testQueue();
  await ingestEvents(deployment, [eventsBody(Date.now())], queue);
  const real = processEventsDeps(deployment);
  const calls: string[] = [];
  const failFirst =
    <Args extends unknown[], Result>(name: string, run: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      calls.push(name);
      if (calls.filter((call) => call === name).length === 1) throw new Error("down");
      return run(...args);
    };
  const settled = await drain(
    queue,
    envelopeHandler(deployment, {
      events: {
        insertTraceEventRejects: failFirst("rejects", real.insertTraceEventRejects),
        insertTraceEvents: failFirst("events", real.insertTraceEvents),
      },
    }),
    3,
  );
  assert.deepEqual(
    settled.map(({ outcome }) => outcome),
    ["retry", "retry", "ack"],
  );
  const dump = await dumpTables(deployment);
  assert.equal(dump.jobs.length, 3);
  assert.equal(dump.trace_event_rejects.length, 2);
  await deployment.client.close();
});

test("a body without events is a dead letter", async () => {
  const deployment = await setupDeployment();
  const store = memoryStore();
  const queue = testQueue(store);
  // The gateway refuses these; another writer may not.
  const bodies = ["secret", "[]", JSON.stringify({ events: Array(5_001).fill({}) })];
  await ingestEvents(deployment, bodies.map(text), queue);
  await drain(queue, envelopeHandler(deployment), bodies.length);
  assert.deepEqual(store.deadLetters.map(({ reason }) => reason).sort(), [
    "body has more than 5000 events",
    "body is not JSON with an events array",
    "body is not JSON with an events array",
  ]);
  await deployment.client.close();
});

test("the key's last use and the facts' bounds are the time of accept", async () => {
  const deployment = await setupDeployment();
  const accepted = new Date("2026-11-20T10:00:00.000Z");
  // An hour before accept: bounded to five minutes before it, not before the time of the store.
  const body = eventsBody(accepted.getTime() - 3_600_000);
  const result = await envelopeHandler(deployment)(envelopeOf("events", body, accepted.getTime()), {
    attempt: 1,
  });
  assert.deepEqual(result, { outcome: "ack" });
  const { rows } = await deployment.client.query<{ at: Date }>(`
    select last_used_at as at from api_keys where id = '${SECRET_KEY_ID}'
    union all select facts_started_at from runtime_event_sources where project_id = '${PROJECT_ID}'
    union all select first_used_at from tool_usage_counters
    union all select last_used_at from tool_usage_counters`);
  assert.deepEqual(
    rows.map(({ at }) => at.toISOString()),
    ["2026-11-20T10:00:00.000Z", ...Array(3).fill("2026-11-20T09:55:00.000Z")],
  );
  await deployment.client.close();
});
