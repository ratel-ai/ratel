#!/usr/bin/env -S npx tsx
// Run: RATEL_S3_TEST_BUCKET=my-bucket ./src/test-s3.ts
import assert from "node:assert/strict";
import { IntentGraph, S3IntentGraphStorage, StaleIntentGraphError } from "@ratel-ai/sdk";

const rawBucket = process.env.RATEL_S3_TEST_BUCKET;
if (!rawBucket) {
  console.error("set RATEL_S3_TEST_BUCKET (and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
  process.exit(1);
}
const bucket: string = rawBucket;
const key = process.env.RATEL_S3_TEST_KEY ?? "ratel/intent-graph-s3-test.json";
const region = process.env.RATEL_S3_TEST_REGION ?? "us-east-1";
const endpoint = process.env.RATEL_S3_TEST_ENDPOINT;
const forcePathStyle =
  process.env.RATEL_S3_TEST_FORCE_PATH_STYLE === undefined
    ? undefined
    : process.env.RATEL_S3_TEST_FORCE_PATH_STYLE !== "false";
const idleTimeoutMs = process.env.RATEL_S3_TEST_IDLE_TIMEOUT_MS
  ? Number(process.env.RATEL_S3_TEST_IDLE_TIMEOUT_MS)
  : undefined;

const graph = (rev: number) =>
  IntentGraph.fromJson(JSON.stringify({ v: 1, built_from_ts: Date.now(), rev, intents: [] }));
const storage = () =>
  new S3IntentGraphStorage({ bucket, key, region, endpoint, forcePathStyle, idleTimeoutMs });

async function main() {
  const initial = storage();
  const before = await initial.load();
  const rev = (before?.rev ?? 0) + 1;
  await initial.save(graph(rev));

  const reloaded = await storage().load();
  assert.ok(reloaded, "object should exist after save");
  assert.equal(reloaded.rev, rev, "reloaded rev should match what was written");

  const skipCheck = storage();
  await skipCheck.load();
  await skipCheck.save(graph(rev)); // save-when-changed: no-op, must not throw

  const writerA = storage();
  const writerB = storage();
  await writerA.load();
  await writerB.load();
  await writerA.save(graph(rev + 1));
  await assert.rejects(
    () => writerB.save(graph(rev + 2)),
    StaleIntentGraphError,
    "stale writer should raise StaleIntentGraphError",
  );

  const final = await storage().load();
  assert.equal(final?.rev, rev + 1, "stale writer's save must not have landed");

  console.log(`PASS (s3-support-adaptive-ranking): s3://${bucket}/${key}, rev=${final.rev}`);
}

main().catch((err) => {
  console.error("FAIL (s3-support-adaptive-ranking):", err);
  process.exit(1);
});
