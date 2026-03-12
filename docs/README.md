# Agentified Documentation

Your agent has 200 tools. The LLM sees 5. Agentified picks the right ones — **86% cost reduction, same accuracy**.

## TypeScript / JavaScript

- **[Getting Started](./typescript/getting-started.md)** — Install, paste-and-run, see results in 2 minutes
- **[Mastra Integration](./typescript/integrations/mastra.md)** — Full-stack Mastra + React + Inspector
- **[Frontend Tools](./typescript/frontend-tools.md)** — Client-side tool execution, React hooks, iteration loop

## Python

- **[Getting Started](./python/getting-started.md)** — Install, paste-and-run, see results in 2 minutes
- **[LangGraph Integration](./python/integrations/langgraph.md)** — LangGraph + Gemini multi-turn agent

## Agentified Server

- **[Architecture](./server/architecture.md)** — System design, registration/discovery flows, ranking algorithm
- **[REST API](./server/api.md)** — Endpoint summary and configuration
- **[Hybrid Ranking](./server/ranking.md)** — Semantic + BM25 scoring, field weights, worked examples
- **[Session Continuity](./server/session-continuity.md)** — Turn capture, tool boosting, multi-turn patterns
- **[Graph Expansion](./server/graph-expansion.md)** — requires/provides metadata, auto-injection
- **[Storage](./server/storage.md)** — In-memory vs SQLite, WAL mode, persistence config

## Examples

| Example | What it shows |
|---------|---------------|
| [ts-sdk-smoke](../examples/ts-sdk-smoke/) | SDK basics — register, discover, context assembly (no LLM) |
| [ts-mastra-smoke](../examples/ts-mastra-smoke/) | Mastra adapter — LLM generation, tool calling, AG-UI streaming |
| [QuickHR](../examples/quickhr/) | Full-stack Mastra + React app |
| [py-sdk-smoke](../examples/py-sdk-smoke/) | Python SDK basics — register, discover, context assembly |
| [py-langchain-sdk-smoke](../examples/py-langchain-sdk-smoke/) | LangChain adapter — LLM tool calling |

## Package READMEs

| Package | Description |
|---------|-------------|
| [agentified-core](../src/core/README.md) | Rust server — hybrid ranking, sub-ms discovery |
| [@agentified/sdk](../src/ts-packages/sdk/README.md) | TypeScript SDK — register, assemble context, track sessions |
| [@agentified/fe-client](../src/ts-packages/fe-client/README.md) | Frontend client — browser tool execution, streaming |
| [@agentified/react](../src/ts-packages/react/README.md) | React hooks + Inspector debug panel |
| [@agentified/mastra](../src/ts-packages/mastra/README.md) | Mastra adapter — agent + context assembly in one call |
| [agentified (Python)](../src/py-packages/sdk/README.md) | Python SDK — async/sync clients, context assembly |
| [agentified-langchain](../src/py-packages/langchain/README.md) | LangChain adapter — native StructuredTool injection |

## Specs

See [`specs/`](./specs/) for protocol and format specifications.
