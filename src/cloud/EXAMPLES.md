# Cloud client examples

Worked examples for sending **agent events** to a Ratel Cloud endpoint, one per supported language.
Every example populates the same unified [`Event`](../../docs/adr/0013-cloud-telemetry-unified-schema.md)
shape; the only difference is the host language.

- Schema reference: [`core/README.md`](core/README.md)
- Client references: [TypeScript](ts/README.md) · [Python](python/README.md)
- The shape is kept identical across languages by the shared [conformance fixtures](fixtures/).

A minimal valid event needs `provider`, `model`, `ts`, and a non-empty `messages` array; everything
else (`system`, `tools`, `params`, `usage`, `finish_reason`, …) is optional. When you use the batching
client's `record`, `ts` may also be omitted — the client stamps the current time. Pass `ts` explicitly
for replayed or backfilled events, and always for the stateless `sendBatch` / `send_batch` path (the
wire schema still requires it).

## TypeScript / JavaScript

### Batching client

`RatelCloud` validates, queues, and flushes in the background — `record` never blocks or throws.

```ts
import { RatelCloud } from "@ratel-ai/cloud";

const cloud = new RatelCloud({
  endpoint: "https://cloud.ratel.ai/api/v1/events",
  apiKey: process.env.RATEL_CLOUD_API_KEY!,
  onError: (err) => console.warn("ratel-cloud:", err), // dropped events + swallowed transport errors
});

cloud.record({
  provider: "openai",
  model: "gpt-5.5",
  ts: new Date().toISOString(),
  stream: false,
  messages: [{ role: "user", content: "Weather in Paris?" }],
  usage: { input_tokens: 82, output_tokens: 41 },
  finish_reason: "stop",
});

await cloud.close(); // stop the timer and flush what's queued
```

### A tool-calling turn

Tool-call `arguments` are a **parsed object**, never a JSON string. A `tool` message references the
call by `tool_call_id`.

```ts
cloud.record({
  provider: "anthropic",
  model: "claude-opus-4-8",
  ts: new Date().toISOString(),
  system: "You are a helpful assistant.",
  tools: [
    {
      name: "get_weather",
      description: "Look up current weather for a location.",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    },
  ],
  messages: [
    { role: "user", content: "Weather in Paris?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_call", id: "call_1", name: "get_weather", arguments: { location: "Paris" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "18°C, cloudy" },
  ],
  usage: { input_tokens: 140, output_tokens: 12 },
  finish_reason: "tool_call",
});
```

### Stateless send (edge / serverless)

Skip the queue and POST a batch yourself with `sendBatch` — handy on request-scoped runtimes (Vercel
Edge, Cloudflare Workers) where a long-lived background timer doesn't fit. It retries transient
failures and never throws.

```ts
import { sendBatch, validate } from "@ratel-ai/cloud";

const event = { /* … as above … */ };
const check = validate(event);
if (!check.ok) throw new Error(check.issues.map((i) => `${i.path} ${i.message}`).join("; "));

const result = await sendBatch([event], {
  endpoint: "https://cloud.ratel.ai/api/v1/events",
  apiKey: env.RATEL_CLOUD_API_KEY,
});
// result → { ok, accepted, status }
```

## Python

### Batching client

Use `RatelCloud` as an async context manager to run the periodic flush; `record` is non-blocking and
never raises.

```python
import os
from ratel_ai_cloud import RatelCloud

async def main() -> None:
    async with RatelCloud(
        endpoint="https://cloud.ratel.ai/api/v1/events",
        api_key=os.environ["RATEL_CLOUD_API_KEY"],
        on_error=lambda err: print("ratel-cloud:", err),
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
    # on exit: timer stopped, queue drained
```

### Reusing a connection pool

Pass your own `httpx.AsyncClient` (which you own and close) so batches share a pool:

```python
import httpx
from ratel_ai_cloud import RatelCloud

async with httpx.AsyncClient() as http, RatelCloud(
    endpoint="https://cloud.ratel.ai/api/v1/events",
    api_key=api_key,
    client=http,
) as cloud:
    cloud.record(event)
    await cloud.flush()  # force a drain before you're done
```

### Stateless send

```python
from ratel_ai_cloud import send_batch, validate

check = validate(event)
if not check.ok:
    raise ValueError("; ".join(f"{i.path} {i.message}" for i in check.issues))

result = await send_batch(
    [event],
    endpoint="https://cloud.ratel.ai/api/v1/events",
    api_key=api_key,
)
# result.ok, result.accepted, result.status
```

## Rust

The `ratel-ai-cloud` crate is the canonical **schema + validation** — no transport. Build an `Event`,
validate it, and serialize to JSON for the wire (POST it with your HTTP client of choice).

```rust
use ratel_ai_cloud::{Content, Event, FinishReason, Message, Usage, validate};

let event = Event {
    provider: "openai".into(),
    model: "gpt-5.5".into(),
    ts: "2026-06-30T12:00:00Z".into(),
    stream: false,
    latency_ms: Some(842),
    system: Some("You are a helpful assistant.".into()),
    tools: vec![],
    messages: vec![
        Message::User { content: Content::Text("Weather in Paris?".into()) },
        Message::Assistant { content: Content::Text("18°C, cloudy.".into()) },
    ],
    params: None,
    usage: Some(Usage {
        input_tokens: 82,
        output_tokens: 41,
        cached_tokens: None,
        reasoning_tokens: None,
    }),
    finish_reason: Some(FinishReason::Stop),
};

validate(&event)?;                              // Result<(), ValidationError>
let body = serde_json::to_string(&event)?;      // ready to POST as application/json
```

Tool calls live in `Message::Assistant` content blocks via `Block::ToolCall { id, name, arguments }`,
where `arguments` is a `serde_json::Value` object; a tool result is a `Message::Tool { tool_call_id,
content }`. See [`core/README.md`](core/README.md) and the [fixtures](fixtures/valid/) for full shapes.
