# `observability/`

Lean cloud analytics for the Python SDK: ship one *usage rollup* per agent
interaction to Ratel's cloud, the exact shape the dashboard renders. A rollup
carries token spend broken down by the five context sources (`skills`, `tools`,
`history`, `memory`, `user_input`), plus what Ratel selection saved and what it
*could* save — counts and identity only, never prompt or output text. Design is
locked in [ADR-0013](../../../../../docs/adr/0013-observability-and-analytics.md)
(Rust-core analytics, one cloud endpoint) and
extends [ADR-0009](../../../../../docs/adr/0009-trace-events-core-owned-schema.md)
(the core-owned trace schema).

The analytics maths — token estimation, full-catalog-vs-selected savings, and
cost — live in `ratel-ai-core` and are called through the native binding; this
package is a thin client that assembles and ships. Only `httpx` is required (the
`ratel-ai[observability]` extra); the rest is stdlib. Absent an API key the
client runs in no-op mode and never raises.

## Layout

```
config.py    ObservabilityConfig — resolve kwargs > env > defaults; events_url
rollup.py    build_rollup() — assemble the wire rollup; calls the native cost estimator
client.py    RatelClient.track() + get_client() singleton; enqueue and flush rollups
exporter.py  BatchProcessor — background daemon thread, batched POST to /api/v1/events
_emit.py     Exporter protocol + Noop/Capture exporters (and the core-stream recorder)
```

## Usage

```python
from ratel_ai import get_client

get_client().track(
    tokens_by_category={"skills": 120, "tools": 2000, "history": 3400,
                        "memory": 260, "user_input": 340},
    saved_by_category={"tools": 7200},   # optional: kept out of the prompt this run
    model="claude-sonnet-4-6", output_tokens=180, latency_ms=420,  # cost_usd auto-estimated
)
get_client().flush()   # also auto-flushed at process exit
```

Pass the per-source spend as exact counts (`tokens_by_category`) or as raw
`context` the SDK token-counts for you; `input_tokens` defaults to its sum and
`cost_usd` is estimated in-core from `model` + tokens when omitted. Each
`track()` enqueues onto a bounded queue; the background thread batches by
size/interval and POSTs a JSON array to `{host}/api/v1/events`, retrying 5xx,
dropping 4xx/overflow, and never blocking or raising.

Config via `RATEL_API_KEY` and `RATEL_HOST` (default `https://cloud.ratel.sh`),
with `RATEL_FLUSH_AT`, `RATEL_FLUSH_INTERVAL`, `RATEL_MAX_QUEUE`, `RATEL_TIMEOUT`,
and `RATEL_SAMPLE_RATE` tuning the exporter. `ToolCatalog(observe=True)` records
savings from the native registry onto `last_savings` and the local trace stream,
ready to fold into a `track()` call. A runnable demo lives at
[`../../examples/observability_demo.py`](../../examples/observability_demo.py).
