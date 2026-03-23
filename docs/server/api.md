# REST API

agentified-core exposes a REST API for tool registration, discovery, session tracking, and message persistence.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check |
| `POST` | `/api/v1/datasets/{id}/tools` | Register tools (batch embed + store) |
| `GET` | `/api/v1/datasets/{id}/tools` | List registered tools |
| `POST` | `/api/v1/datasets/{id}/discover` | Discover relevant tools (hybrid ranking) |
| `POST` | `/api/v1/turns` | Capture a turn for session continuity |
| `POST` | `/api/v1/messages` | Append messages to a conversation |
| `GET` | `/api/v1/messages` | Retrieve conversation messages |
| `POST` | `/api/v1/context` | Get context with strategy, token budget, and optional tool recall |

The context endpoint (`POST /api/v1/context`) accepts `keep_first` and `annotate_summary` in its `messages` config. See [agentified-core README](../../src/core/README.md#post-apiv1context) for details.

Full request/response schemas and examples: [agentified-core README](../../src/core/README.md#api-reference).

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for `text-embedding-3-small` |
| `AGENTIFIED_PORT` | No | `9119` | HTTP server port |
| `AGENTIFIED_STORAGE` | No | — | Set to `"sqlite"` for persistence |
| `AGENTIFIED_DB_PATH` | No | `./agentified.db` | SQLite database file path |

## See Also

- [Architecture](./architecture.md) — System design and ranking algorithm
- [Storage](./storage.md) — In-memory vs SQLite configuration
