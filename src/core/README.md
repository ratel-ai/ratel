# agentified-core

Rust server. BM25 / semantic / hybrid ranking. Sub-millisecond discovery.

Registers tools, computes embeddings, and serves the most relevant subset for any query via a REST API. See [Architecture](../../docs/server/architecture.md) for the full system design.

## Quick Start

### Docker (recommended)

```bash
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core
```

### From source

```bash
cd src/core
OPENAI_API_KEY=sk-... cargo run
# Server starts on http://localhost:9119
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for `text-embedding-3-small` |
| `AGENTIFIED_PORT` | No | `9119` | HTTP server port |
| `AGENTIFIED_STORAGE` | No | — | Set to `"sqlite"` for persistent storage |
| `AGENTIFIED_DB_PATH` | No | `./agentified.db` | SQLite DB path (when storage=sqlite) |

See [Storage docs](../../docs/server/storage.md) for persistence details.

## API Reference

All tool endpoints are scoped to a dataset. The SDKs handle dataset IDs automatically.

### `GET /health`

Health check.

```json
{ "status": "ok" }
```

### `POST /api/v1/datasets/{id}/tools`

Register tools. Each tool is embedded (name, description, schemas) and stored for later discovery.

**Request:**

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
      "metadata": { "category": "weather" }
    }
  ]
}
```

**Response:**

```json
{ "registered": 1 }
```

Embeddings are computed in batch via OpenAI `text-embedding-3-small` and cached by content hash. Subsequent registrations of identical tools skip embedding.

### `GET /api/v1/datasets/{id}/tools`

List all registered tools in a dataset.

**Response:**

```json
{
  "tools": [
    { "name": "get_weather", "description": "...", "parameters": { ... }, "metadata": null, "fields": { ... } }
  ]
}
```

### `POST /api/v1/datasets/{id}/discover`

Discover the most relevant tools for a query. The `strategy` field selects the ranker — **BM25 is the default**. See [Ranking docs](../../docs/server/ranking.md).

**Request:**

```json
{
  "query": "What's the weather in Rome?",
  "strategy": "bm25",
  "limit": 5,
  "exclude": ["irrelevant_tool"],
  "turn_id": "prev-turn-uuid",
  "embedding_weights": {
    "name": 0.1,
    "description": 0.5,
    "input_schema": 0.3,
    "output_schema": 0.1
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Natural language query |
| `strategy` | string | `"bm25"` | Ranker to use: `"bm25"`, `"semantic"`, or `"hybrid"` |
| `limit` | number | 5 | Max tools to return (max 100) |
| `exclude` | string[] | [] | Tool names to exclude |
| `turn_id` | string | — | Previous turn ID for [session continuity](../../docs/server/session-continuity.md) |
| `embedding_weights` | object | see below | Field weights for `semantic` / `hybrid` scoring |

**Default embedding weights:** name=0.1, description=0.5, input_schema=0.3, output_schema=0.1

**Ranking algorithm:**

The `strategy` field selects the ranker (default `bm25`). See [Ranking docs](../../docs/server/ranking.md) for the full comparison.

1. If `strategy = "bm25"`: tokenize the query, compute BM25 (`k1=0.9`, `b=0.4`) over per-tool documents (name + description + JSON Schema field names), min-max normalize to `[0, 1]`.
2. If `strategy = "semantic"`: embed the query via `text-embedding-3-small`, compute weighted cosine similarity across tool fields (name, description, input_schema, output_schema).
3. If `strategy = "hybrid"`: compute both of the above; `final_score = 0.7 × semantic + 0.3 × normalized_bm25`.
4. `always_include` tools are excluded from ranked results — they are injected unconditionally by the SDK.
5. If `turn_id` is provided, tools from that turn are prepended with `score = 1.0`.
6. [Graph expansion](../../docs/server/graph-expansion.md) injects dependency tools.
7. `semantic` / `hybrid` fall back to `bm25` if embeddings are unavailable.

**Response:**

```json
{
  "tools": [
    { "name": "get_weather", "description": "...", "parameters": { ... }, "score": 0.92, "graph_expanded": false }
  ]
}
```

### `POST /api/v1/turns`

Capture a turn for [session continuity](../../docs/server/session-continuity.md). Returns a `turn_id` to pass to subsequent `discover` calls.

**Request:**

```json
{
  "tools_loaded": ["get_weather", "search_docs"],
  "message": "What's the weather in Rome?"
}
```

**Response:**

```json
{ "turn_id": "550e8400-e29b-41d4-a716-446655440000" }
```

### `POST /api/v1/messages`

Append messages to a conversation session.

**Request:**

```json
{
  "dataset": "my-dataset",
  "namespace": "default",
  "session": "session-123",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

### `GET /api/v1/messages`

Retrieve messages from a conversation session. Supports pagination via `after_seq` and `around_seq` query parameters.

### `POST /api/v1/context`

Get context for a session with strategy, token budget, and optional tool recall.

**Strategies:** `recent`, `full`, `summary`, `recent+summary`

- `summary` — LLM-summarizes entire conversation; returns raw summary text + `summary_range`
- `recent+summary` — recent messages (60% budget) + LLM summary of older messages (40% budget)
- Summary strategies fall back to `recent` if LLM fails (`fallback: true`)

**Message options** (inside `messages` config object):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | string | `"recent"` | Message selection strategy |
| `max_tokens` | number | 4000 | Token budget for messages |
| `keep_first` | bool | `false` | Always include the first user message in the result |

**`keep_first`:** When enabled, the first `role: "user"` message is always included, regardless of the token budget. Useful for preserving the original prompt/intent in long conversations. Has no effect on `full` strategy.

**Summary output:** When using summary strategies, the response includes `summary` (raw text) and `summary_range` (`{ first_seq, last_seq, count }`) — the SDK uses these to construct an annotated assistant message in the messages array.

**Recall:** Pass `"recall": {"tools": true}` or `{"tools": {"limit": 5, "min_similarity": 0.7}}` to auto-discover tools based on the last user message. Recalled tools persist across calls within the same session.

**Token budget:** `limit_tokens` caps total assembly (tools + messages). Tool token cost is subtracted from the message budget.

See [Chat Management](../../docs/server/chat-management.md) for the full guide.

## Storage

By default, agentified-core runs fully in-memory. Set `AGENTIFIED_STORAGE=sqlite` for persistence across restarts.

SQLite uses WAL mode and stores: tools, turns, embedding cache, and messages. On startup, all data is loaded into memory. Writes are async (fire-and-forget). See [Storage docs](../../docs/server/storage.md).

## Docker

### Build

```bash
docker build -t agentified-core src/core/
```

### With SQLite persistence

```bash
docker run -p 9119:9119 \
  -e OPENAI_API_KEY=sk-... \
  -e AGENTIFIED_STORAGE=sqlite \
  -v ./data:/app/data \
  -e AGENTIFIED_DB_PATH=/app/data/agentified.db \
  agentified/agentified-core
```

## Links

- [Root README](../../README.md)
- [Architecture](../../docs/server/architecture.md)
- [TypeScript SDK](../ts-packages/sdk/README.md)
- [Python SDK](../py-packages/sdk/README.md)
- [QuickHR Example](../../examples/quickhr/)

## License

[Sustainable Use License](./LICENSE) — free for internal, non-commercial, and personal use. See [LICENSE.md](../../LICENSE.md) for the full dual-license terms.
