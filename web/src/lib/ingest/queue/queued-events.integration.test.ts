import assert from "node:assert/strict";
import { test } from "node:test";
import { listDeadLetters } from "@/lib/ingest/queue/postgres/store";
import { handleRuntimeEventsRequest } from "@/lib/ingest/trace-events/route-handler";
import {
  acceptOnto,
  type Deployment,
  drain,
  dumpTables,
  envelopeHandler,
  eventsBody,
  eventsRouteDeps,
  type IngestBody,
  ingestEvents,
  ingestRequest,
  PROJECT_ID,
  processEventsDeps,
  SECRET_KEY_ID,
  SHARED_KEY,
  setupDeployment,
  spoolQueue,
} from "./test-support";

const text = (value: string): IngestBody => ({
  contentType: "application/json",
  bytes: new TextEncoder().encode(value),
});

async function queued(bodies: readonly IngestBody[]): Promise<Deployment> {
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  await ingestEvents(deployment, bodies, acceptOnto(queue));
  await drain(queue, envelopeHandler(deployment), bodies.length);
  return deployment;
}

for (const [label, key] of [
  ["a secret key", undefined],
  ["an append-only key", SHARED_KEY],
] as const) {
  test(`${label}: a queued deployment stores the same rows and jobs as a direct one`, async () => {
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

test("the route counts the batch, refuses what it refused, and stores nothing", async () => {
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  const send = (body: IngestBody) =>
    handleRuntimeEventsRequest(
      ingestRequest("events", body),
      eventsRouteDeps(deployment, { accept: acceptOnto(queue) }),
    );
  const accepted = await send(eventsBody(Date.now()));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: 8, duplicates: 0, rejected: [] });

  const refusals: [IngestBody, number, string][] = [
    [text("not json"), 400, "Malformed JSON payload."],
    [text("[]"), 400, "Malformed runtime-events payload: expected { events: [] }."],
    [
      text(JSON.stringify({ events: Array(5_001).fill({}) })),
      413,
      "Too many events in one batch (max 5000).",
    ],
    [
      { ...text("{}"), contentType: "application/x-protobuf" },
      415,
      "Unsupported Content-Type. Send application/json.",
    ],
  ];
  for (const [body, status, error] of refusals) {
    const response = await send(body);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  const { rows } = await deployment.client.query("select id from trace_events");
  assert.equal(rows.length, 0);
  await deployment.client.close();
});

test("a publish that fails is a 503 with Retry-After", async () => {
  const deployment = await setupDeployment();
  const publish = async () => Promise.reject(new Error("down"));
  const response = await handleRuntimeEventsRequest(
    ingestRequest("events", eventsBody(Date.now())),
    eventsRouteDeps(deployment, { accept: acceptOnto({ publish }) }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  await deployment.client.close();
});

test("a failed store is retried and still starts the follow-up jobs", async () => {
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  await ingestEvents(deployment, [eventsBody(Date.now())], acceptOnto(queue));
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

test("another writer's body without events is a dead letter", async () => {
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  const direct = acceptOnto(queue);
  // The core's accept refuses these; the gateway is another writer.
  const bodies = ["secret", "[]", JSON.stringify({ events: Array(5_001).fill({}) })];
  await ingestEvents(deployment, [eventsBody(Date.now())], {
    ...direct,
    queue: {
      publish: async (envelope) => {
        for (const body of bodies) {
          await queue.publish({ ...envelope, body: new TextEncoder().encode(body) });
        }
      },
    },
  });
  await drain(queue, envelopeHandler(deployment), bodies.length);
  assert.deepEqual((await listDeadLetters(deployment.db)).map(({ reason }) => reason).sort(), [
    "body has more than 5000 events",
    "body has no events array",
    "body is not JSON",
  ]);
  await deployment.client.close();
});

test("the key's last use and the facts' bounds are the time of accept", async () => {
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  const accepted = new Date("2026-11-20T10:00:00.000Z");
  await handleRuntimeEventsRequest(
    // An hour before accept: bounded to five minutes before it, not before the time of the store.
    ingestRequest("events", eventsBody(accepted.getTime() - 3_600_000)),
    eventsRouteDeps(deployment, { accept: acceptOnto(queue), now: () => accepted }),
  );
  await drain(queue, envelopeHandler(deployment), 1);
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
