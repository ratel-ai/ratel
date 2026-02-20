# Agentified

Context Intelligence Layer for AI agents. The middle layer between agent frameworks and LLM providers — handling what the agent *knows*, *selects*, and *learns*.

## Architecture

```
agentified/
├── core/                 # Rust server (agentified-core)
│   ├── Cargo.toml
│   └── src/
├── scripts/              # Test scripts
│   └── test-server.sh
└── README.md
```

### agentified-core

Rust HTTP server providing:
- **Tool registration** — register tools with name, description, and JSON schema parameters
- **Embedding computation** — OpenAI `text-embedding-3-small` with content-hash caching
- **Context resolution** — hybrid ranking (semantic similarity + BM25) to select relevant tools for a query

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/v1/tools` | POST | Register tools |
| `/api/v1/tools` | GET | List all tools |
| `/api/v1/discover` | POST | Discover relevant tools for a query |

## Quick Start

```bash
cd core
cargo run
# Server starts on localhost:9119
```

### Environment Variables

- `OPENAI_API_KEY` — required for embeddings
- `AGENTIFIED_PORT` — server port (default: 9119)

## License

MIT
