import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createPostgresQueue } from "@/lib/ingest/queue/postgres/postgres-queue";
import { listDeadLetters } from "@/lib/ingest/queue/postgres/store";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { decodeEnvelope, type Envelope, encodeEnvelope } from "./envelope";
import {
  acceptOnto,
  type Deployment,
  deploymentOver,
  drain,
  dumpTables,
  envelopeHandler,
  eventsBody,
  type IngestBody,
  ingestEvents,
  ingestLogs,
  ingestTraces,
  killableClient,
  logsBody,
  modelCallBody,
  SHARED_KEY,
  setupDeployment,
  spoolQueue,
  usageOf,
} from "./test-support";

/**
 * Delivery is at least once (ADR-0009): a message that is processed again, and a process that is
 * killed at any statement, must leave every table as one clean run does. The exceptions are listed
 * in the ADR.
 */

const REAL = join(import.meta.dirname, "../otlp/__fixtures__/real");
const FIXTURES = readdirSync(REAL, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => name);
const AT = Date.now() - 60_000;

/** Columns that a second run must not change, and that differ between two databases. */
const KEEP = ["otlp_raw_exports.id", "api_keys.last_used_at"];

/** The counter can miss a killed delivery's events; it never counts them twice. Compared apart. */
async function tablesOf(deployment: Deployment): Promise<Record<string, string[]>> {
  const { test_event_usage: _usage, ...dump } = await dumpTables(deployment, { keep: KEEP });
  return dump;
}

interface Batch {
  traces?: IngestBody[];
  logs?: IngestBody[];
  events?: IngestBody[];
}

/** The envelopes of a batch, as accept publishes them. */
async function envelopesOf({ traces = [], logs = [], events = [] }: Batch): Promise<Envelope[]> {
  const deployment = await setupDeployment();
  const published: Envelope[] = [];
  const accept = acceptOnto({
    publish: async (envelope) => {
      published.push(decodeEnvelope(encodeEnvelope(envelope)));
    },
  });
  await ingestTraces(deployment, traces, accept);
  await ingestLogs(deployment, logs, accept);
  await ingestEvents(deployment, events, accept);
  await deployment.client.close();
  return published;
}

async function processAll(deployment: Deployment, envelopes: readonly Envelope[]): Promise<void> {
  const handler = envelopeHandler(deployment);
  for (const envelope of envelopes) {
    assert.deepEqual(await handler(envelope, { attempt: 1 }), { outcome: "ack" });
  }
}

async function cleanRun(envelopes: readonly Envelope[]) {
  const deployment = await setupDeployment();
  await processAll(deployment, envelopes);
  const result = { tables: await tablesOf(deployment), usage: await usageOf(deployment) };
  await deployment.client.close();
  return result;
}

const SMALL: [string, () => Promise<Envelope[]>][] = [
  ["traces", () => envelopesOf({ traces: [loadFixture("vercel-ai")[0]] })],
  [
    "logs before their spans",
    async () => {
      const [traces, logs] = await envelopesOf({ traces: [modelCallBody()], logs: [logsBody()] });
      return [logs, traces];
    },
  ],
  ["spans before their logs", () => envelopesOf({ traces: [modelCallBody()], logs: [logsBody()] })],
  ["spans without a time", () => envelopesOf({ traces: [modelCallBody("0")], logs: [logsBody()] })],
  ["events", () => envelopesOf({ events: [eventsBody(AT)] })],
  ["events of an append-only key", () => envelopesOf({ events: [eventsBody(AT, SHARED_KEY)] })],
];

for (const [label, load] of SMALL) {
  test(`${label}: killed at every statement, then delivered again, equals a clean run`, async () => {
    const envelopes = await load();
    const clean = await cleanRun(envelopes);
    let killPoints = 0;
    for (let at = 1; ; at++) {
      const healthy = await setupDeployment();
      const connection = killableClient(healthy.client, at);
      const dying = envelopeHandler(deploymentOver(connection.client));
      for (const envelope of envelopes) {
        if (connection.dead()) break;
        await dying(envelope, { attempt: 1 });
      }
      const finished = !connection.dead();
      // The next process reads the queue from the message in hand; here, from the start.
      await processAll(healthy, envelopes);
      assert.deepEqual(await tablesOf(healthy), clean.tables, `killed at statement ${at}`);
      assert.ok((await usageOf(healthy)) <= clean.usage, `usage, killed at statement ${at}`);
      await healthy.client.close();
      if (finished) break;
      killPoints += 1;
    }
    assert.ok(killPoints >= 8, `${killPoints} kill points`);
  });
}

test("the real fixtures, logs and events: processed twice equals processed once", async () => {
  const envelopes = await envelopesOf({
    traces: FIXTURES.flatMap((name) => loadFixture(name)),
    logs: [logsBody(), logsBody(SHARED_KEY)],
    events: [eventsBody(AT), eventsBody(AT, SHARED_KEY)],
  });
  const clean = await cleanRun(envelopes);
  const twice = await setupDeployment();
  await processAll(twice, envelopes);
  await processAll(twice, envelopes);
  assert.deepEqual(await tablesOf(twice), clean.tables);
  assert.equal(await usageOf(twice), clean.usage);
  assert.ok(clean.usage > 50);
  await twice.client.close();
});

test("the real fixtures through the queue, with the consumer killed mid-batch, equals a clean run", async () => {
  const envelopes = await envelopesOf({
    traces: ["vercel-ai", "mcp-python-fastmcp", "pydantic-ai"].flatMap((name) => loadFixture(name)),
    logs: [logsBody()],
    events: [eventsBody(AT)],
  });
  const clean = await cleanRun(envelopes);
  const healthy = await setupDeployment();
  for (const envelope of envelopes) await spoolQueue(healthy).publish(envelope);

  // Each process dies at another statement: in a claim, in a store, or between a store and its ack.
  let killed = 0;
  for (const at of [3, 17, 38, 45, 61]) {
    const connection = killableClient(healthy.client, at);
    const dying = deploymentOver(connection.client);
    const queue = createPostgresQueue({ db: dying.db, pollMs: 2, leaseMs: 150 });
    const consumer = queue.consume(envelopeHandler(dying));
    const deadline = Date.now() + 10_000;
    while (!connection.dead() && Date.now() < deadline && (await left(healthy)) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (connection.dead()) killed += 1;
    // The stop cannot write anything: it only ends the loop of the dead process.
    await consumer.stop();
    // The claim of a message in hand ends.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(killed, 5);
  const remaining = await left(healthy);
  assert.ok(remaining > 0, "the last process has work left");
  await drain(spoolQueue(healthy), envelopeHandler(healthy), remaining);
  assert.equal(await left(healthy), 0);
  assert.deepEqual(await listDeadLetters(healthy.db), []);
  assert.deepEqual(await tablesOf(healthy), clean.tables);
  assert.ok((await usageOf(healthy)) <= clean.usage);
  await healthy.client.close();
});

test("an event that an earlier crash left without metrics gets them on a replay", async () => {
  const envelopes = await envelopesOf({ traces: [loadFixture("vercel-ai")[0]] });
  const clean = await cleanRun(envelopes);
  const deployment = await setupDeployment();
  await processAll(deployment, envelopes);
  await deployment.client.exec("delete from event_metrics");
  await processAll(deployment, envelopes);
  assert.deepEqual(await tablesOf(deployment), clean.tables);
  await deployment.client.close();
});

async function left({ client }: Deployment): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from ingest_spool where dead_at is null",
  );
  return rows[0].n;
}
