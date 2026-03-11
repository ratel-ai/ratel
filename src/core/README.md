# agentified-core

Rust server. Hybrid ranking. Sub-millisecond discovery.

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

Discover the most relevant tools for a query using hybrid ranking. See [Ranking docs](../../docs/server/ranking.md).

**Request:**

```json
{
  "query": "What's the weather in Rome?",
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
| `limit` | number | 5 | Max tools to return (max 100) |
| `exclude` | string[] | [] | Tool names to exclude |
| `turn_id` | string | — | Previous turn ID for [session continuity](../../docs/server/session-continuity.md) |
| `embedding_weights` | object | see below | Field weights for semantic scoring |

**Default embedding weights:** name=0.1, description=0.5, input_schema=0.3, output_schema=0.1

**Ranking algorithm:**
1. Embed query using `text-embedding-3-small`
2. Compute weighted cosine similarity across tool fields (name, description, input_schema, output_schema)
3. Compute BM25 scores over concatenated tool text
4. Normalize BM25 to [0, 1]
5. Final score = `0.7 × semantic + 0.3 × BM25`
6. If `turn_id` provided, tools from that turn are prepended with score=1.0
7. [Graph expansion](../../docs/server/graph-expansion.md) injects dependency tools

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

Get context for a session with a strategy (`recent` or `full`) and token budget.

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
