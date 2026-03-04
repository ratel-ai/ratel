<p align="center">
  <h1 align="center">Agentified</h1>
  <p align="center"></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agentified/sdk"><img src="https://img.shields.io/npm/v/@agentified/sdk?label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/agentified/"><img src="https://img.shields.io/pypi/v/agentified?label=pypi" alt="PyPI"></a>
  <a href="https://hub.docker.com/r/agentified/agentified-core"><img src="https://img.shields.io/docker/v/agentified/agentified-core?label=docker" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

---

**Agentified** is the middle layer between agent frameworks and LLM providers — handling what the agent *knows*, *selects*, and *learns*. It registers your tools, uses hybrid semantic + BM25 ranking to select the right ones for each query, and tracks sessions so context improves across turns.

## How It Works

```
┌─────────────┐      ┌──────────────────────┐      ┌───────────┐
│  Your Agent │ ──── │   agentified-core    │ ──── │  OpenAI   │
│  (TS / Py)  │      │   (Rust HTTP server) │      │ Embeddings│
└─────────────┘      └──────────────────────┘      └───────────┘
       │                       │
   1. Register tools      Embeds & caches
   2. Discover (query)    Hybrid rank (0.7 semantic + 0.3 BM25)
   3. Execute top tools   Session continuity via turns
```

## Quick Start

### 1. Start the server

```bash
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core
```

### 2. Use from TypeScript

```bash
npm install @agentified/sdk
```

```typescript
import { Agentified, tool } from "@agentified/sdk";

const agent = new Agentified({
  serverUrl: "http://localhost:9119",
  tools: [
    tool({ name: "get_weather", description: "Get current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }),
    tool({ name: "search_docs", description: "Search documentation", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }),
  ],
});

await agent.register();
const ranked = await agent.prefetch({ messages: [{ role: "user", content: "What's the weather in Rome?" }] });
// → [{ name: "get_weather", score: 0.92, ... }]
```

### 3. Use from Python

```bash
pip install agentified
```

```python
from agentified import Agentified, AgentifiedConfig, tool

async with Agentified(AgentifiedConfig(
    server_url="http://localhost:9119",
    tools=[
        tool(name="get_weather", description="Get current weather for a city", parameters={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
        tool(name="search_docs", description="Search documentation", parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}),
    ],
)) as agent:
    await agent.register()
    ranked = await agent.prefetch(messages=[{"role": "user", "content": "What's the weather in Rome?"}])
    # → [RankedTool(name="get_weather", score=0.92, ...)]
```

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [`agentified-core`](src/core/README.md) | Rust HTTP server — tool registration, embeddings, hybrid ranking | `docker pull agentified/agentified-core` |
| [`@agentified/sdk`](src/ts-packages/sdk/README.md) | TypeScript SDK — register, discover, prefetch, session turns | `npm i @agentified/sdk` |
| [`@agentified/fe-client`](src/ts-packages/fe-client/README.md) | Frontend client — AG-UI streaming, frontend tool handling, inspector state | `npm i @agentified/fe-client` |
| [`@agentified/react`](src/ts-packages/react/README.md) | React bindings — Provider, hooks, Inspector debug panel | `npm i @agentified/react` |
| [`@agentified/mastra`](src/ts-packages/mastra/README.md) | Mastra adapter — generate, AG-UI streaming, SSE helpers | `npm i @agentified/mastra` |
| [`agentified`](src/py-packages/sdk/README.md) | Python SDK — async/sync clients, Pydantic models | `pip install agentified` |

## Architecture

```
agentified/
├── src/
│   ├── core/                 # Rust server (axum, tokio, rusqlite)
│   ├── ts-packages/
│   │   ├── sdk/              # @agentified/sdk
│   │   ├── fe-client/        # @agentified/fe-client
│   │   ├── react/            # @agentified/react
│   │   └── mastra/           # @agentified/mastra
│   └── py-packages/
│       └── sdk/              # agentified (PyPI)
├── examples/
│   ├── quickhr/              # Full-stack HR app (Mastra + React)
│   └── py-langgraph/         # Python LangGraph integration
├── benchmarks/
└── scripts/
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check → `{ "status": "ok" }` |
| `/api/v1/tools` | POST | Register tools (batch, with auto-embedding) |
| `/api/v1/tools` | GET | List all registered tools |
| `/api/v1/discover` | POST | Discover relevant tools for a query (hybrid ranking) |
| `/api/v1/turns` | POST | Capture a turn for session continuity |

## Examples

- **[QuickHR](examples/quickhr/)** — Full-stack HR app with 150+ tools, Mastra agent backend, React frontend with Inspector
- **[Python LangGraph](examples/py-langgraph/)** — LangGraph reactive agent with Agentified context resolution

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for embeddings |
| `AGENTIFIED_PORT` | No | `9119` | Server port |
| `AGENTIFIED_STORAGE` | No | — | `"sqlite"` for persistence, omit for in-memory |
| `AGENTIFIED_DB_PATH` | No | `./agentified.db` | SQLite database path (when storage=sqlite) |

## Contributing

Contributions welcome! Please open an issue or PR.

## License

MIT
