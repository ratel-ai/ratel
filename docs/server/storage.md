# Storage

agentified-core supports two storage modes: in-memory (default) and SQLite.

## In-Memory (Default)

No configuration needed. All data lives in `HashMap`s behind `RwLock`s. Fast, but data is lost on restart.

Best for: development, testing, stateless deployments where tools are re-registered on startup.

## SQLite

Enable with environment variables:

```bash
AGENTIFIED_STORAGE=sqlite
AGENTIFIED_DB_PATH=./agentified.db  # optional, this is the default
```

Docker with persistence:

```bash
docker run -p 9119:9119 \
  -e OPENAI_API_KEY=sk-... \
  -e AGENTIFIED_STORAGE=sqlite \
  -v ./data:/app/data \
  -e AGENTIFIED_DB_PATH=/app/data/agentified.db \
  agentified/agentified-core
```

### WAL Mode

SQLite runs with `PRAGMA journal_mode=WAL` and `PRAGMA synchronous=NORMAL`:

- **WAL** — concurrent readers don't block writers (important since discovery reads are frequent)
- **synchronous=NORMAL** — slightly faster writes, safe for WAL mode

### What's Persisted

| Table | Contents | Key |
|-------|----------|-----|
| `tools` | Tool definitions, field embeddings (as float32 blobs), BM25 text | `(dataset_id, name)` |
| `turns` | tools_loaded list, user message | `turn_id` |
| `embedding_cache` | Text → 1536-dim embedding vector | `text_content` |
| `messages` | Conversation messages with sequence numbers | `(dataset_id, namespace_id, session_id, seq)` |

### Startup Loading

On startup, all turns and embedding cache entries are loaded into memory. Tools are loaded per-dataset on first access. This means:

- **Discovery is always in-memory** — SQLite is only hit on write
- **Writes are async** — `spawn_blocking` fire-and-forget, no write latency on the request path

### Schema

```sql
CREATE TABLE tools (
    dataset_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    parameters TEXT NOT NULL,
    metadata TEXT,
    fields TEXT,
    emb_name BLOB NOT NULL,
    emb_description BLOB NOT NULL,
    emb_input_schema BLOB,
    emb_output_schema BLOB,
    bm25_text TEXT NOT NULL,
    PRIMARY KEY (dataset_id, name)
);

CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    tools_loaded TEXT NOT NULL,  -- JSON array
    message TEXT NOT NULL
);

CREATE TABLE embedding_cache (
    text_content TEXT PRIMARY KEY,
    embedding BLOB NOT NULL      -- float32 LE bytes
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_call_id TEXT,
    tool_calls TEXT,
    created_at TEXT NOT NULL,
    seq INTEGER NOT NULL
);
```

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for embeddings |
| `AGENTIFIED_PORT` | No | `9119` | HTTP server port |
| `AGENTIFIED_STORAGE` | No | — | Set to `"sqlite"` for persistence |
| `AGENTIFIED_DB_PATH` | No | `./agentified.db` | SQLite database file path |

## See Also

- [Architecture](./architecture.md) — How storage fits in the system
- [agentified-core README](../../src/core/README.md) — Server configuration and Docker setup
