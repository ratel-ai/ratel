# Agentified Documentation

Your agent has 200 tools. The LLM sees 5. Agentified picks the right ones — **86% cost reduction, same accuracy**.

## Getting Started

- **[Getting Started](./getting-started.md)** — Install, run the server, register + discover in TS/Python

## Architecture

- **[Architecture](./architecture.md)** — System design, registration/discovery flows, ranking algorithm, storage

## Concepts

- **[Hybrid Ranking](./concepts/ranking.md)** — Semantic + BM25 scoring, field weights, worked examples
- **[Session Continuity](./concepts/session-continuity.md)** — Turn capture, tool boosting, multi-turn patterns
- **[Graph Expansion](./concepts/graph-expansion.md)** — requires/provides metadata, auto-injection
- **[Frontend Tools](./concepts/frontend-tools.md)** — Client-side tool execution, React hooks, iteration loop
- **[Storage](./concepts/storage.md)** — In-memory vs SQLite, WAL mode, persistence config

## Guides

- **[Mastra + React](./guides/mastra.md)** — Full-stack: Mastra agent + Agentified + React + Inspector
- **[LangGraph + Python](./guides/langgraph.md)** — LangGraph + Python SDK + Gemini

## Examples

| Example | What it shows |
|---------|---------------|
| [sdk-smoke](../examples/sdk-smoke/) | SDK basics — register, discover, session continuity (no LLM) |
| [mastra-smoke](../examples/mastra-smoke/) | Mastra adapter — LLM generation, tool calling, AG-UI streaming |
| [QuickHR](../examples/quickhr/) | Full-stack Mastra + React app |
| [LangGraph Agent](../examples/py-langgraph/) | Python + LangGraph + Gemini |

## Package READMEs

| Package | Description |
|---------|-------------|
| [agentified-core](../src/core/README.md) | Rust server — hybrid ranking, sub-ms discovery |
| [@agentified/sdk](../src/ts-packages/sdk/README.md) | TypeScript SDK — register, discover, track sessions |
| [@agentified/fe-client](../src/ts-packages/fe-client/README.md) | Frontend client — browser tool execution, streaming |
| [@agentified/react](../src/ts-packages/react/README.md) | React hooks + Inspector debug panel |
| [@agentified/mastra](../src/ts-packages/mastra/README.md) | Mastra adapter — agent + discovery in one call |
| [agentified (Python)](../src/py-packages/sdk/README.md) | Python SDK — async/sync clients |
