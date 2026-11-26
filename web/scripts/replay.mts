#!/usr/bin/env tsx
/**
 * Stores the envelopes of one replay topic again, without counting usage (`src/ingest-replay.ts`), and
 * exits when all of them are settled. A private tool publishes them and runs this, bundled.
 *
 *   replay --topic <topic> --expect <envelopes> --mode fill|rebuild --from <unix ms> --to <unix ms>
 *
 * Needs DATABASE_URL and the INGEST_KAFKA_* settings. `<topic>.dead` takes what can not be stored.
 * REPLAY_TRACE_METERING names a module whose `createTraceMetering()` returns the decisions made before.
 * Prints counts only. Exits 1 when an envelope could not be stored.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { getConfig } from "@/config";
import { configuredHandler } from "@/ingest-consumer";
import {
  addToRange,
  emptyRange,
  keepPartialTraces,
  rebuildHandler,
  removeRange,
  type ReplayRange,
} from "@/ingest-replay";
import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import { decodeEnvelope, type Envelope } from "@/lib/ingest/queue/envelope";
import { createKafkaClient } from "@/lib/ingest/queue/kafka/client";
import { createKafkaQueue } from "@/lib/ingest/queue/kafka/kafka-queue";
import { getDb } from "@/lib/platform/db/client";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      topic: { type: "string" },
      expect: { type: "string" },
      mode: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });
  const expected = Number(values.expect);
  const [from, to] = [Number(values.from), Number(values.to)];
  if (!values.topic || !Number.isInteger(expected) || !(from < to)) {
    throw new Error("usage: replay --topic <t> --expect <n> --mode fill|rebuild --from <ms> --to <ms>");
  }
  if (values.mode !== "fill" && values.mode !== "rebuild") throw new Error("--mode is not fill or rebuild");
  const { topic, mode } = values as { topic: string; mode: "fill" | "rebuild" };
  const { brokers = "", security, region } = getConfig().ingest.kafka;
  const kafka = await createKafkaClient({
    brokers: brokers.split(",").map((b) => b.trim()).filter(Boolean),
    security,
    region,
  });
  const isMargin = (envelope: Envelope) => envelope.receivedAt < from || envelope.receivedAt >= to;

  let keptTraces = 0;
  let handler = configuredHandler({ traceMetering: loadMetering() });
  if (mode === "rebuild") {
    const range = await scan(kafka, topic, expected, isMargin);
    await getDb().transaction(
      async (tx) => {
        keptTraces = await keepPartialTraces(tx, range);
        await removeRange(tx, range);
      },
      { isolationLevel: "repeatable read" },
    );
    handler = rebuildHandler(handler, range, isMargin);
  }

  const counts = { ack: 0, "dead-letter": 0 };
  const queue = createKafkaQueue(kafka, {
    topics: async () => [topic],
    groupId: `ratel-replay.${topic}`,
    deadLetterTopic: `${topic}.dead`,
  });
  await new Promise<void>((resolve) => {
    if (expected === 0) return resolve();
    const consumer = queue.consume(handler, {
      onSettled: ({ outcome }) => {
        if (outcome !== "ack" && outcome !== "dead-letter") return;
        counts[outcome] += 1;
        if (counts.ack + counts["dead-letter"] === expected) void consumer.stop().then(resolve);
      },
    });
  });
  await queue.close();
  console.log(
    JSON.stringify({
      event: "replayed",
      mode,
      stored: counts.ack,
      deadLettered: counts["dead-letter"],
      // Filled, not rebuilt: a span of theirs is in no replayed envelope.
      ...(mode === "rebuild" ? { keptTraces } : {}),
    }),
  );
  process.exit(counts["dead-letter"] > 0 ? 1 : 0);
}

function loadMetering(): TraceMeteringPort | undefined {
  const path = process.env.REPLAY_TRACE_METERING;
  if (!path) return undefined;
  const module = createRequire(process.cwd() + "/")(path) as {
    createTraceMetering: () => TraceMeteringPort;
  };
  return module.createTraceMetering();
}

/** What the envelopes of the range stored. Reads the whole topic once, before anything is removed. */
async function scan(
  kafka: Awaited<ReturnType<typeof createKafkaClient>>,
  topic: string,
  expected: number,
  isMargin: (envelope: Envelope) => boolean,
): Promise<ReplayRange> {
  const range = emptyRange();
  if (expected === 0) return range;
  const consumer = kafka.consumer({ groupId: `ratel-replay.${topic}.scan.${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  let seen = 0;
  await new Promise<void>((resolve, reject) => {
    void consumer.run({
      autoCommit: false,
      eachMessage: async ({ message }) => {
        try {
          if (message.value) {
            const envelope = decodeEnvelope(message.value);
            addToRange(range, envelope, isMargin(envelope));
          }
        } catch (error) {
          reject(error);
        }
        seen += 1;
        if (seen === expected) resolve();
      },
    });
  });
  await consumer.disconnect();
  return range;
}

main().catch((error) => {
  console.error(`replay failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
