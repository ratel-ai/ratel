import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { hardenPoolClients } from "@/lib/platform/db/pool";
import * as tables from "@/lib/platform/db/tables";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { reapStaleIngestBatches } from "../queries";
import {
  type Deployment,
  drainLane,
  dumpTables,
  envelopeHandler,
  envelopeOf,
  eventsBody,
  FAST_POLICY,
  ingestEvents,
  ingestLogs,
  ingestThroughLane,
  ingestTraces,
  logsBody,
  modelCallBody,
  SEED_SQL,
  type Sent,
} from "../test-support";
import { createKafkaClient } from "./client";
import { createKafkaQueue } from "./kafka-queue";

/**
 * One project sends the same telemetry both ways at once (ADR-0010): through a gateway to Kafka, and to the
 * routes with ADR-0009's queue on. Both workers store it at the same time, over a real server. Needs
 * `TEST_KAFKA_BROKERS` and `TEST_POSTGRES_URL` (a server on which databases can be made).
 */
const brokers = process.env.TEST_KAFKA_BROKERS?.split(",");
const server = process.env.TEST_POSTGRES_URL;
const REAL = join(import.meta.dirname, "../../otlp/__fixtures__/real");
const AT = Date.now() - 60_000;
const SENT: Sent = {
  traces: [
    ...readdirSync(REAL, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap(({ name }) => loadFixture(name)),
    modelCallBody(),
  ],
  logs: [logsBody()],
  events: [eventsBody(AT)],
};

interface ServerDeployment extends Deployment {
  database: string;
  /** Ends every connection of the deployment, as a restart of the server does. */
  disconnect(): Promise<void>;
  end(): Promise<void>;
}

async function serverDeployment(url: string): Promise<ServerDeployment> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const database = `both_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database ${database}`);
  const at = new URL(url);
  at.pathname = `/${database}`;
  // As the app's pool, but larger: drizzle never releases a connection whose `begin` fails, so each kill
  // can cost some.
  const pool = new pg.Pool({ connectionString: at.href, max: 60 });
  pool.on("error", () => undefined);
  hardenPoolClients(pool, { logWarn: () => undefined });
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  // As the tests' databases: the edition owns the table.
  await pool.query(
    "create table if not exists organizations (id uuid primary key, name text not null, slug text not null unique)",
  );
  await pool.query(SEED_SQL);
  const client = {
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    exec: (text: string) => pool.query(text),
  } as unknown as Deployment["client"];
  return {
    client,
    db: drizzle(pool, { schema: tables }) as unknown as Deployment["db"],
    logs: [],
    database,
    disconnect: async () => {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [database],
      );
    },
    end: async () => {
      // Not awaited: it waits for the connections that were never released.
      void pool.end();
      await admin.query(`drop database ${database} with (force)`);
      await admin.end();
    },
  };
}

/** Without the raw copies (one per accepted request) and the usage counter, which are compared apart. */
async function rowsOf(deployment: Deployment) {
  const { otlp_raw_exports: raw, test_event_usage: usage, ...dump } = await dumpTables(deployment);
  // A record without a time takes the time of accept, or of the store.
  dump.otel_logs = dump.otel_logs.map((row) =>
    row.includes('"ratel.note"') ? row.replace(/"occurred_at":"[^"]+"/, '"occurred_at":null') : row,
  );
  return { dump, raw: raw.length, usage: JSON.parse(usage[0]).n as number };
}

async function broker(servers: string[]) {
  const kafka = await createKafkaClient({ brokers: servers, security: "plaintext" });
  const admin = kafka.admin();
  await admin.connect();
  const topic = `both-${randomUUID()}`;
  const groupId = `both.${topic}`;
  const deadLetterTopic = `${topic}.dead`;
  await admin.createTopics({
    topics: [
      { topic, numPartitions: 1 },
      { topic: deadLetterTopic, numPartitions: 1 },
    ],
  });
  const high = async (name: string) => Number((await admin.fetchTopicOffsets(name))[0]?.high ?? 0);
  return {
    admin,
    open: () =>
      createKafkaQueue(kafka, {
        topic,
        topics: async () => [topic],
        groupId,
        deadLetterTopic,
        policy: FAST_POLICY,
      }),
    dead: () => high(deadLetterTopic),
    left: async () =>
      (await high(topic)) -
      Math.max(
        0,
        Number((await admin.fetchOffsets({ groupId, topics: [topic] }))[0].partitions[0].offset),
      ),
  };
}

/** Which rows there are, without what is in them. */
function identities(dump: Record<string, string[]>): Record<string, string[]> {
  const keys = [
    "id",
    "event",
    "dedupe_hash",
    "source_id",
    "tool_id",
    "kind",
    "trace_id",
    "span_id",
  ];
  return Object.fromEntries(
    Object.entries(dump).map(([table, rows]) => [
      table,
      rows
        .map((row) => {
          const value = JSON.parse(row) as Record<string, unknown>;
          // The same source and trace can be named by either side.
          const own = value.id ?? value.event ?? value.dedupe_hash;
          return own ? String(own) : keys.map((key) => value[key] ?? "").join(" ");
        })
        .sort(),
    ]),
  );
}

const calls = ({ tool_usage_counters: rows }: Record<string, string[]>) =>
  rows.reduce((sum, row) => sum + Number(JSON.parse(row).calls), 0);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (!brokers || !server) {
  test(
    "both queues",
    { skip: "TEST_KAFKA_BROKERS and TEST_POSTGRES_URL are not set" },
    () => undefined,
  );
} else {
  for (const { name, workers, killed } of [
    { name: "one lane worker, in order: the same rows", workers: 1, killed: false },
    { name: "two lane workers: each row once", workers: 2, killed: false },
    { name: "workers that are killed: each row once, none lost", workers: 2, killed: true },
  ]) {
    test(`the same telemetry both ways at once, ${name}`, async () => {
      const once = await serverDeployment(server);
      await ingestTraces(once, SENT.traces);
      await ingestLogs(once, SENT.logs);
      await ingestEvents(once, SENT.events);
      const expected = await rowsOf(once);
      await once.end();

      const t = await broker(brokers);
      const deployment = await serverDeployment(server);
      const publisher = t.open();
      for (const signal of ["traces", "logs", "events"] as const) {
        for (const body of SENT[signal]) await publisher.publish(envelopeOf(signal, body));
      }
      await publisher.close();
      await ingestThroughLane(deployment, SENT);

      let running = true;
      const lane = async () => {
        while (running) {
          // A killed connection can also lose the record of an outcome: the batch stays `running`, and
          // the reaper gives it to the next worker.
          await drainLane(deployment, 50).catch(() => undefined);
          await wait(50);
        }
      };
      const lanes = Array.from({ length: workers }, lane);
      let queue = t.open();
      let consumer = queue.consume(envelopeHandler(deployment));
      let kills = 0;
      const laneLeft = async () => {
        const { rows } = await deployment.client.query<{ n: number }>(
          "select count(*)::int as n from ingest_batches where status <> 'done'",
        );
        return rows[0].n;
      };
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (killed && kills < 6) {
          await wait(150);
          await deployment.disconnect();
          kills += 1;
          if (kills % 2 === 0) {
            // A worker that stops for good, and the one that takes its place.
            await consumer.stop();
            await queue.close();
            queue = t.open();
            consumer = queue.consume(envelopeHandler(deployment));
          }
        }
        // The waits of minutes are cut; the number of tries and the claim are the real ones.
        await deployment.client
          .query("update ingest_batches set available_at = now() where status = 'queued'")
          .catch(() => undefined);
        await reapStaleIngestBatches(3_000, 50, deployment.db).catch(() => undefined);
        const left = await Promise.all([t.left(), laneLeft().catch(() => 1)]);
        if (left.every((n) => n === 0) && (!killed || kills >= 6)) break;
        assert.ok(Date.now() < deadline, `left: ${left}`);
        await wait(100);
      }
      running = false;
      await Promise.all(lanes);
      await consumer.stop();
      await queue.close();

      const actual = await rowsOf(deployment);
      // The queue has no order between its workers and after a retry, and some rows keep what came first
      // (a tool call that its client and its server both report).
      if (workers === 1) assert.deepEqual(actual.dump, expected.dump);
      assert.deepEqual(identities(actual.dump), identities(expected.dump));
      assert.equal(calls(actual.dump), calls(expected.dump), "no tool call is counted twice");
      assert.equal(await t.dead(), 0, "nothing is dead-lettered");
      const { rows } = await deployment.client.query<{ n: number }>(
        "select count(*)::int as n from ingest_batches where status = 'failed'",
      );
      assert.equal(rows[0].n, 0, "nothing failed");
      // One raw copy per accepted request; a killed try of the lane can lose its copy, never a row.
      assert.ok(
        actual.raw <= expected.raw * 2 && actual.raw >= expected.raw,
        `${actual.raw} copies`,
      );
      // Counted by rows stored: never twice. A kill between the store and the count can miss some.
      assert.ok(actual.usage <= expected.usage, `${actual.usage} of ${expected.usage}`);
      if (!killed) {
        assert.equal(actual.raw, expected.raw * 2);
        assert.equal(actual.usage, expected.usage);
      }
      await deployment.end();
      await t.admin.disconnect();
    });
  }
}
