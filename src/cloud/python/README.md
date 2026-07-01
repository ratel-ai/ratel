<div align="center">
  <h1>ratel-ai-cloud</h1>
  <h4>Pure-Python client for Ratel Cloud telemetry — send agent events to a remote endpoint</h4>
  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/ratel-ai">Discord</a>
  </p>
  <p>
    <a href="https://pypi.org/project/ratel-ai-cloud/"><img alt="PyPI" src="https://img.shields.io/pypi/v/ratel-ai-cloud?color=e57300"></a>
    <a href="../../../LICENSE.md"><img alt="License" src="https://img.shields.io/badge/license-MIT-e57300"></a>
  </p>
</div>

Send **agent events** — the request/response of a single LLM call (model, messages, tools, sampling
params, token usage, finish reason) — to a remote Ratel endpoint. You populate one unified shape
([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)); the client validates, batches,
and ships it best-effort without ever blocking or crashing your app.

Pure Python, no native addon — runs anywhere, including serverless. The event schema mirrors the
canonical [`ratel-ai-cloud` Rust crate](../core/README.md), kept honest by the shared
[conformance fixtures](../fixtures/).

## Install

```bash
pip install ratel-ai-cloud
```

## Quickstart

```python
from ratel_ai_cloud import RatelCloud

async with RatelCloud(
    endpoint="https://cloud.ratel.ai/api/v1/events",
    api_key="rtl_...",
) as cloud:
    cloud.record({
        "provider": "openai",
        "model": "gpt-5.5",
        "ts": "2026-06-30T12:00:00Z",
        "stream": False,
        "messages": [{"role": "user", "content": "Weather in Paris?"}],
        "usage": {"input_tokens": 82, "output_tokens": 41},
        "finish_reason": "stop",
    })
```

`record` validates and enqueues without awaiting the network. Batches flush on a timer (when used as
an `async with` context), on reaching `batch_size`, or via `await cloud.flush()`. Pass your own
`httpx.AsyncClient` to reuse a connection pool; otherwise each batch uses a transient client.

## API

- **`record(event)`** — validate (unless `validate_events=False`) and enqueue. `ts` may be omitted
  (the client stamps the current time; override the clock with the `now` argument); pass it explicitly
  for replayed/backfilled events. Invalid events are dropped and reported via `on_error`.
- **`await flush()`** — drain the queue in `batch_size`-bounded requests (`MAX_BATCH` = 500).
- **`await aclose()`** — stop the timer and flush. Also runs on `async with` exit.
- **`validate(event) -> ValidationResult`** — the standalone validator.
- **`send_batch(events, *, endpoint, api_key, ...)`** — the stateless transport, if you want to manage
  batching yourself.

## Develop

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai_cloud && .venv/bin/pytest
```

## Layout

```
ratel_ai_cloud/
  events.py      canonical event TypedDicts (mirror of the Rust schema)
  validate.py    semantic validation → ValidationResult
  transport.py   httpx batch POST with retry/backoff (send_batch)
  client.py      RatelCloud — non-blocking record / flush / close
tests/           validator, transport (httpx.MockTransport), conformance
```
