# `examples/s3-support-adaptive-ranking-python` — live S3 intent graph storage test

The Python mirror of [`examples/s3-support-adaptive-ranking`](../s3-support-adaptive-ranking/README.md): a **live** smoke test of `S3IntentGraphStorage` ([docs/adr/0025](../../docs/adr/0025-intent-graph-storage-plugins.md)) against a real S3-compatible bucket — AWS or self-hosted (MinIO, etc.) — not a mocked one.

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
| `RATEL_S3_TEST_KEY`      | no                               | `ratel/intent-graph-s3-test-v1.json` |
| `RATEL_S3_TEST_REGION`   | no                               | `us-east-1`                       |
| `RATEL_S3_TEST_ENDPOINT` | no                               | unset (AWS S3)                    |
| `RATEL_S3_TEST_FORCE_PATH_STYLE` | no                       | `true` if `RATEL_S3_TEST_ENDPOINT` is set, else n/a |
| `RATEL_S3_TEST_IDLE_TIMEOUT_S` | no                         | `60` (abort after this long with no data moving) |

### Against a local MinIO instead of AWS

```bash
docker run -d -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=ratelminio -e MINIO_ROOT_PASSWORD=ratelminiosecret \
  quay.io/minio/minio server /data --console-address ":9001"
# create the bucket once, with quay.io/minio/mc or the MinIO console on :9001

RATEL_S3_TEST_BUCKET=my-bucket \
RATEL_S3_TEST_ENDPOINT=http://localhost:9000 \
AWS_ACCESS_KEY_ID=ratelminio \
AWS_SECRET_ACCESS_KEY=ratelminiosecret \
uv run test_s3.py
```

## What it checks

Same five checks as the TS version: `load()` on a possibly-empty key, `save()` writes a graph, a fresh storage instance `load()`s it back and the `rev` matches, saving the same `rev` again is a no-op, and two storage instances racing to `save()` produce one success and one real `StaleIntentGraphError` from S3's `412 Precondition Failed`.

## Layout

```
test_s3.py   the whole test — no framework, just ratel_ai
```
