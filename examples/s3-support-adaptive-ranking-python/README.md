# `examples/s3-support-adaptive-ranking-python` — live S3 intent graph storage test

The Python mirror of [`examples/s3-support-adaptive-ranking`](../s3-support-adaptive-ranking/README.md): a **live** smoke test of `ExperimentalS3IntentGraphStorage` ([docs/adr/0025](../../docs/adr/0025-intent-graph-storage-plugins.md)) against a real AWS S3 bucket, not a mocked one.

It never runs in CI (no AWS credentials there) — it's for manual verification.

## Setup

```bash
RATEL_S3_TEST_BUCKET=my-bucket \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
uv run test_s3.py
```

Or, once the environment is built (`uv sync`), run the script directly (it's executable):

```bash
RATEL_S3_TEST_BUCKET=my-bucket ./test_s3.py
```

`uv run` resolves `ratel-ai` from this monorepo (see `[tool.uv.sources]` in `pyproject.toml`), building the native extension on first run.

### Environment variables

| Variable                | Required                       | Default                          |
| ------------------------ | ------------------------------- | --------------------------------- |
| `RATEL_S3_TEST_BUCKET`   | yes                              | —                                  |
| `AWS_ACCESS_KEY_ID`      | yes                              | —                                  |
| `AWS_SECRET_ACCESS_KEY`  | yes                              | —                                  |
| `AWS_SESSION_TOKEN`      | if using temporary credentials  | —                                  |
| `RATEL_S3_TEST_KEY`      | no                               | `ratel/intent-graph-s3-test.json` |
| `RATEL_S3_TEST_REGION`   | no                               | `us-east-1`                       |

## What it checks

Same five checks as the TS version: `load()` on a possibly-empty key, `save()` writes a graph, a fresh storage instance `load()`s it back and the `rev` matches, saving the same `rev` again is a no-op, and two storage instances racing to `save()` produce one success and one real `StaleIntentGraphError` from S3's `412 Precondition Failed`.

## Layout

```
test_s3.py   the whole test — no framework, just ratel_ai
```
