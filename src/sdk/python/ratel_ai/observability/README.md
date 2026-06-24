# `observability/`

Langfuse-style observability & analytics for the Python SDK: capture LLM
generations, function traces, and tool usage, and ship them to Ratel's cloud.
Design is locked in [ADR-0012](../../../../../docs/adr/0012-python-observability-layer.md)
(the layer) and [ADR-0013](../../../../../docs/adr/0013-cloud-ingestion-contract.md)
(the SDK→cloud wire contract). Identity/usage facts also flow into the core trace
stream ([ADR-0009](../../../../../docs/adr/0009-trace-events-core-owned-schema.md)).

Only `httpx` is required (the `ratel-ai[observability]` extra); the rest is
stdlib. Absent an API key, the client runs in no-op mode and never raises.

## Layout

```
config.py      ObservabilityConfig — resolve kwargs > env > defaults
models.py      wire dataclasses (to_wire()) — the cloud ingestion payload
context.py     contextvars: current trace / observation stack; id + clock helpers
trace.py       Observation and Trace handles (.update / .end)
client.py      RatelClient + get_client() singleton; opens and finishes observations
decorator.py   @observe — wrap any sync/async function into a trace node
exporter.py    BatchProcessor — background queue + httpx POST, retry/backoff, flush
estimator.py   TokenEstimator protocol; char/4 default, optional tiktoken
savings.py     full-catalog vs top-K token savings for Ratel tool selection
_emit.py       Exporter protocol, capture/no-op exporters, core-stream recorder
```

## Usage

```python
from ratel_ai import observe, get_client

@observe()
def handle(task: str) -> str:
    ...

get_client().update_current_trace(user_id="u1", session_id="s1")
get_client().flush()
```

Drop-in provider wrappers live one level up at [`../openai.py`](../openai.py) and
[`../anthropic.py`](../anthropic.py) (engine in [`../integrations/`](../integrations/)).
Config via `RATEL_API_KEY`, `RATEL_HOST`, `RATEL_CAPTURE_INPUT/OUTPUT`,
`RATEL_FLUSH_AT`, `RATEL_FLUSH_INTERVAL`, `RATEL_SAMPLE_RATE`.
