import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { resolveConfig } from "@/config";
import type { IngestResult, SettledDelivery } from "@/lib/contracts/ingest-queue";
import { envelope } from "@/lib/ingest/queue/port/test-support/conformance";
import { createMemoryQueue } from "@/lib/ingest/queue/port/test-support/memory-queue";
import { consumesKafkaIngest } from "@/lib/jobs/role";
import { COUNTS_EVERY_MS, startIngestConsumer, stopConsumerOnSignal } from "./consumer";

type Line = { level: string; message: string; fields: Record<string, unknown> };
const running: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((consumer) => consumer.stop()));
});

function recorder() {
  const lines: Line[] = [];
  const at = (level: string) => (fields: unknown, message?: string) => {
    lines.push({ level, message: message ?? "", fields: fields as Record<string, unknown> });
  };
  return { lines, log: { info: at("info"), warn: at("warn"), error: at("error") } as never };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("retries and dead letters are log lines, and the counts are logged at the stop", async () => {
  const policy = { waitsMs: [1], outageWaitMs: { first: 1, max: 1 } };
  const queue = createMemoryQueue(undefined, policy);
  const { lines, log } = recorder();
  const results: IngestResult[] = [
    { outcome: "ack" },
    { outcome: "outage", reason: "down" },
    { outcome: "retry", reason: "busy" },
    { outcome: "retry", reason: "still busy" },
  ];
  const consumer = startIngestConsumer({
    queue,
    handler: async () => results.shift() ?? { outcome: "ack" },
    log,
  });
  const projectId = randomUUID();
  const ids = [envelope(projectId), envelope(projectId)];
  for (const message of ids) await queue.publish(message);
  await until(() => lines.some(({ message }) => message === "ingest_message_dead_lettered"));
  await consumer.stop();
  await consumer.stop();

  const dead = { project_id: projectId, message_id: ids[1].id };
  assert.deepEqual(lines, [
    { level: "info", message: "ingest consumer started", fields: {} },
    {
      level: "warn",
      message: "ingest_store_unavailable",
      fields: { ...dead, attempt: 1, reason: "down" },
    },
    {
      level: "warn",
      message: "ingest_message_retried",
      fields: { ...dead, attempt: 1, reason: "busy" },
    },
    {
      level: "error",
      message: "ingest_message_dead_lettered",
      fields: { ...dead, attempt: 2, reason: "still busy" },
    },
    {
      level: "info",
      message: "ingest_queue_processed",
      fields: { processed: 1, retried: 1, outages: 1, dead_lettered: 1 },
    },
    { level: "info", message: "ingest consumer stopped", fields: {} },
  ]);
});

test("a process has one consumer, and can start another after it stopped", async () => {
  const queue = createMemoryQueue();
  const handler = async (): Promise<IngestResult> => ({ outcome: "ack" });
  const { log, lines } = recorder();
  const first = startIngestConsumer({ queue, handler, log });
  assert.equal(startIngestConsumer({ queue, handler, log }), first);
  await first.stop();
  const second = startIngestConsumer({ queue, handler, log });
  running.push(second);
  assert.notEqual(second, first);
  assert.equal(lines.filter(({ message }) => message === "ingest consumer started").length, 2);
});

test("the counts are one line a minute, and none when nothing happened", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let settle: (settled: SettledDelivery) => void = () => undefined;
  const { lines, log } = recorder();
  const consumer = startIngestConsumer({
    queue: {
      publish: async () => undefined,
      consume: (_handler, options) => {
        settle = options?.onSettled ?? settle;
        return { stop: async () => undefined };
      },
    },
    handler: async () => ({ outcome: "ack" }),
    log,
  });
  running.push(consumer);
  const counts = () => lines.filter(({ message }) => message === "ingest_queue_processed");
  t.mock.timers.tick(COUNTS_EVERY_MS);
  assert.equal(counts().length, 0);
  settle({ messageId: "m", projectId: "p", attempt: 1, outcome: "ack", reason: null });
  t.mock.timers.tick(COUNTS_EVERY_MS);
  t.mock.timers.tick(COUNTS_EVERY_MS);
  assert.deepEqual(
    counts().map(({ fields }) => fields),
    [{ processed: 1, retried: 0, outages: 0, dead_lettered: 0 }],
  );
});

test("only the process that runs background work reads Kafka, and only with INGEST_QUEUE=kafka", () => {
  const consumes = (APP_ROLE: string, INGEST_QUEUE: string) =>
    consumesKafkaIngest(resolveConfig({ env: { APP_ROLE, INGEST_QUEUE } }));
  for (const role of ["worker", "all", ""]) assert.equal(consumes(role, "kafka"), true, role);
  for (const role of ["api", "ingest", "persist"])
    assert.equal(consumes(role, "kafka"), false, role);
  for (const role of ["api", "worker", "all", "ingest", "persist"]) {
    assert.equal(consumes(role, "direct"), false, role);
  }
});

test("a second signal exits at once; without an exit of its own, the stop leaves it to Next", async () => {
  const exits: number[] = [];
  const listeners: Record<string, () => void> = {};
  let release: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    on: (signal: string, listener: () => void) => {
      listeners[signal] = listener;
    },
    exit: (code: number) => {
      exits.push(code);
    },
  };
  stopConsumerOnSignal({ stop: () => stopped }, { ...deps, ownsExit: true });
  listeners.SIGTERM();
  assert.deepEqual(exits, []);
  listeners.SIGINT();
  assert.deepEqual(exits, [1]);
  release();
  await until(() => exits.length === 2);
  assert.deepEqual(exits, [1, 0]);

  let flushed = false;
  stopConsumerOnSignal(
    { stop: async () => Promise.reject(new Error("broker gone")) },
    {
      ...deps,
      ownsExit: false,
      beforeExit: async () => {
        flushed = true;
      },
    },
  );
  listeners.SIGTERM();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(exits, [1, 0]);
  assert.equal(flushed, false);
});

test("on SIGTERM a process finishes the message in hand, acknowledges it and exits 0", async () => {
  const script = join(import.meta.dirname, "__fixtures__/process/consume-until-signal.ts");
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: join(import.meta.dirname, "../../../.."),
    env: { ...process.env, LOG_LEVEL: "silent" },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk
      .toString()
      .split("\n")
      .filter((line) => line && !line.startsWith("{"));
    lines.push(...text);
    if (text.includes("in hand")) child.kill("SIGTERM");
  });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.deepEqual(lines, ["in hand", "handled", "settled ack", "flushed"]);
  assert.equal(code, 0);
});
