# `examples/s3-support-adaptive-ranking` — live S3 intent graph storage test

A **live** smoke test of `ExperimentalS3IntentGraphStorage` ([docs/adr/0025](../../docs/adr/0025-intent-graph-storage-plugins.md)) against a real AWS S3 bucket — not the fake-transport unit tests in `src/sdk/ts/src/intent-graph-storage.test.ts`. It exists to answer one question: **can the hand-rolled SigV4 client actually store and retrieve an intent graph in S3?**

It never runs in CI (no AWS credentials there) — it's for manual verification.

## Setup

```bash
pnpm install
RATEL_S3_TEST_BUCKET=my-bucket \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
pnpm -F @ratel-ai/example-s3-support-adaptive-ranking start
```

Or, once `@ratel-ai/sdk` is built and dependencies are installed, run the script directly (it's executable):

```bash
RATEL_S3_TEST_BUCKET=my-bucket ./src/test-s3.ts
```

### Environment variables

| Variable                  | Required | Default                              |
| -------------------------- | -------- | ------------------------------------- |
| `RATEL_S3_TEST_BUCKET`     | yes      | —                                      |
| `AWS_ACCESS_KEY_ID`        | yes      | —                                      |
| `AWS_SECRET_ACCESS_KEY`    | yes      | —                                      |
| `AWS_SESSION_TOKEN`        | if using temporary credentials | —              |
| `RATEL_S3_TEST_KEY`        | no       | `ratel/intent-graph-s3-test.json`     |
| `RATEL_S3_TEST_REGION`     | no       | `us-east-1`                           |

The IAM identity needs `s3:GetObject` and `s3:PutObject` on the target key. No special bucket configuration is required — S3 conditional writes (`If-Match`/`If-None-Match`, used for stale-write detection) have been GA since August 2024 and don't need bucket versioning enabled.

## What it checks

1. `load()` on whatever's currently at the key (may be `null` on a fresh key).
2. `save()` writes a graph.
3. A **fresh** storage instance `load()`s it back and the `rev` matches — confirms the SigV4-signed `PutObject`/`GetObject` round trip actually works against real S3.
4. Saving the same `rev` again is a no-op (save-when-changed).
5. Two storage instances both `load()` the same base, one `save()`s first, and the second's `save()` is expected to raise `StaleIntentGraphError` from a real `412 Precondition Failed` — confirms conditional-write staleness detection isn't just a unit-test fiction.

The script prints `PASS`/`FAIL` per check and exits non-zero if anything failed. It leaves the last-written object behind, so a re-run also exercises the "object already exists" path.

## Layout

```
src/test-s3.ts   the whole test — no framework, just @ratel-ai/sdk
```
