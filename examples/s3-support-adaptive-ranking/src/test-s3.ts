#!/usr/bin/env -S npx tsx
// Live smoke test for ExperimentalS3IntentGraphStorage (docs/adr/0025) against
// a *real* S3 bucket — not the fake-transport unit tests in
// src/sdk/ts/src/intent-graph-storage.test.ts. Confirms the hand-rolled SigV4
// client can actually write and read an intent graph in S3, and that
// conditional-write staleness detection works against S3's real ETags.
//
// Usage:
//   RATEL_S3_TEST_BUCKET=my-bucket pnpm start
// or, once @ratel-ai/sdk is built and deps installed, run it directly:
//   RATEL_S3_TEST_BUCKET=my-bucket ./src/test-s3.ts
//
// Required:
//   RATEL_S3_TEST_BUCKET   S3 bucket to read/write against
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   (+ AWS_SESSION_TOKEN if temporary)
// Optional:
//   RATEL_S3_TEST_KEY      object key (default: ratel/intent-graph-s3-test.json)
//   RATEL_S3_TEST_REGION   bucket region (default: us-east-1)
//
// This talks to real AWS and leaves one object behind at the end (the last
// graph written) so a re-run exercises the "object already exists" path too.
import {
  ExperimentalS3IntentGraphStorage,
  IntentGraph,
  StaleIntentGraphError,
} from "@ratel-ai/sdk";

const rawBucket = process.env.RATEL_S3_TEST_BUCKET;
const key = process.env.RATEL_S3_TEST_KEY ?? "ratel/intent-graph-s3-test.json";
const region = process.env.RATEL_S3_TEST_REGION ?? "us-east-1";

if (!rawBucket) {
  console.error(
    "RATEL_S3_TEST_BUCKET is not set.\n\n" +
      "Usage: RATEL_S3_TEST_BUCKET=my-bucket AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm start\n\n" +
      "The IAM identity needs s3:GetObject and s3:PutObject on the target key " +
      "(s3:PutObject with x-amz-if-match/x-amz-if-none-match support for the " +
      "conditional-write check — this requires no special bucket configuration, " +
      "just a reasonably current AWS account; S3 conditional writes have been " +
      "GA since August 2024).",
  );
  process.exit(1);
}
// Narrowed to `string` here; captured as-is by `main()` below since TS does not
// carry the guard's narrowing of a module-scope `let`/`const` into a closure.
const bucket: string = rawBucket;

function graphWithRev(rev: number): IntentGraph {
  return IntentGraph.fromJson(JSON.stringify({ v: 1, built_from_ts: Date.now(), rev, intents: [] }));
}

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log(`target: s3://${bucket}/${key} (region ${region})\n`);

  const storage = new ExperimentalS3IntentGraphStorage({ bucket, key, region });

  console.log("1. load() — read whatever is there now (may be null on a fresh key)");
  const before = await storage.load();
  console.log(`   -> ${before === null ? "null (no object yet)" : `rev ${before.rev}`}`);

  console.log("\n2. save() — write a graph to S3");
  const writeRev = (before?.rev ?? 0) + 1;
  await storage.save(graphWithRev(writeRev));
  console.log(`   -> wrote rev ${writeRev}`);

  console.log("\n3. load() from a fresh storage instance — confirm the round trip");
  const reloaded = await new ExperimentalS3IntentGraphStorage({ bucket, key, region }).load();
  check("object exists after save", reloaded !== null);
  check(
    "reloaded rev matches what was written",
    reloaded?.rev === writeRev,
    `expected ${writeRev}, got ${reloaded?.rev}`,
  );

  console.log("\n4. save() again with the same graph — save-when-changed should skip the PUT");
  const sameGraph = graphWithRev(writeRev);
  // Prime this storage object's internal rev tracking to `writeRev` via load(),
  // then saving the identical rev should be a no-op (no network call, no error).
  const skipCheckStorage = new ExperimentalS3IntentGraphStorage({ bucket, key, region });
  await skipCheckStorage.load();
  await skipCheckStorage.save(sameGraph);
  check("no-op save with unchanged rev did not throw", true);

  console.log("\n5. conditional-write staleness — two writers, one gets StaleIntentGraphError");
  const writerA = new ExperimentalS3IntentGraphStorage({ bucket, key, region });
  const writerB = new ExperimentalS3IntentGraphStorage({ bucket, key, region });
  await writerA.load();
  await writerB.load(); // both now hold the same base ETag

  await writerA.save(graphWithRev(writeRev + 1)); // A advances the object first
  console.log(`   -> writer A advanced to rev ${writeRev + 1}`);

  let staleCaught = false;
  try {
    await writerB.save(graphWithRev(writeRev + 2)); // B's base is now stale
  } catch (error) {
    staleCaught = error instanceof StaleIntentGraphError;
    if (!staleCaught) throw error;
  }
  check("stale writer B raised StaleIntentGraphError", staleCaught);

  const final = await new ExperimentalS3IntentGraphStorage({ bucket, key, region }).load();
  check(
    "final stored rev is writer A's (B's write did not land)",
    final?.rev === writeRev + 1,
    `expected ${writeRev + 1}, got ${final?.rev}`,
  );

  console.log(`\n${failures === 0 ? "all checks passed — S3 storage works." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nS3 storage test failed with an unhandled error:");
  console.error(error);
  process.exit(1);
});
