# CLAUDE.md

## Project Overview

**Agentified** — Context Intelligence Layer for AI agents. This repo contains `agentified-core`, a Rust HTTP server for tool registration and context resolution (intelligent tool selection).

## Project Structure

```
agentified/
├── core/                 # Rust server
│   ├── Cargo.toml
│   └── src/
├── scripts/              # Test scripts
└── README.md
```

## Development Commands

```bash
cd core
cargo build               # Build
cargo build --release     # Release build
cargo run                 # Run server (localhost:9119)
cargo test                # Run tests
```

## Key Information

- **Language**: Rust
- **HTTP framework**: axum
- **Runtime**: tokio
- **Embeddings**: OpenAI text-embedding-3-small
- **Ranking**: Hybrid (0.7 * semantic + 0.3 * BM25)
- **Storage**: In-memory (HashMap)
- **Default port**: 9119

## Environment Variables

- `OPENAI_API_KEY` — required for embeddings
- `AGENTIFIED_PORT` — server port (default: 9119)
