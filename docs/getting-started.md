# Getting Started

Register 200 tools. Get the 5 that matter. **86% fewer tokens, same accuracy.**

## Prerequisites

- **Docker** (recommended) or Rust toolchain
- **OpenAI API key** — used for `text-embedding-3-small` embeddings
- **Node.js 18+** (TypeScript) or **Python 3.10+** (Python)

## 1. Start the server

```bash
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core
```

Verify:

```bash
curl http://localhost:9119/health
# {"status":"ok"}
```

## 2. Register & discover tools

### TypeScript

```bash
npm install agentified
```

```typescript
import { Agentified, tool } from "agentified";

const ag = new Agentified();
await ag.connect("http://localhost:9119");

const dataset = await ag.dataset("my-agent").register({
  tools: [
    { name: "get_weather", description: "Get current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, handler: async (args) => ({ temp: 22, city: args.city }) },
    { name: "search_docs", description: "Search documentation", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, handler: async (args) => ({ results: [] }) },
  ],
});

// dataset.discoverTool — give this to your agent
// dataset.prepareStep  — use as prepareStep callback
// dataset.session(id)  — session-scoped tools + conversation
// dataset.namespace(id) — user-scoped memory (stub)
```

### Python

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

## 3. See what happened

Each ranked tool includes a `score` (0–1) representing relevance. The server:

1. **Embedded** your query using `text-embedding-3-small`
2. **Computed** weighted cosine similarity across 4 tool fields (name, description, input_schema, output_schema)
3. **Combined** with BM25 keyword matching: `final = 0.7 × semantic + 0.3 × BM25`
4. **Returned** the top-K tools sorted by score

Read [Architecture](./architecture.md) for the full deep dive, or [Hybrid Ranking](./concepts/ranking.md) for scoring details.

## Next steps

- **[Architecture](./architecture.md)** — System diagram, registration/discovery flows
- **[Session Continuity](./concepts/session-continuity.md)** — Multi-turn context with turn tracking
- **[Mastra guide](./guides/mastra.md)** — Full-stack TypeScript example
- **[LangGraph guide](./guides/langgraph.md)** — Python + Gemini example
- **[Storage](./concepts/storage.md)** — Enable SQLite persistence
