# CLAUDE.md

## Project Overview

**Agentified** — Context Intelligence Layer for AI agents. This repo contains `agentified-core`, a Rust HTTP server for tool registration and context resolution (intelligent tool selection).

## Project Structure

```
agentified/
├── core/                 # Rust server
│   ├── Cargo.toml
│   └── src/
├── ts-packages/          # TypeScript packages (pnpm workspace)
│   ├── sdk/
│   ├── fe-client/
│   ├── react/
│   └── mastra/
├── scripts/              # Test scripts
└── README.md
```

## Environment Variables

- `OPENAI_API_KEY` — required for embeddings
- `AGENTIFIED_PORT` — server port (default: 9119)
