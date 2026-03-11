<div align="center">
  <img src="https://agentified.dev/assets/logo-new-CNqV8zpW.png" alt="Agentified" height="100" />

  <h2>Agentified</h2>
  <h4>Your agent has 200 tools. The LLM sees 5. Agentified picks the right ones.</h4>

  <p>
    <a href="./docs/">Docs</a> •
    <a href="https://agentified.dev/sandbox">Sandbox</a> •
    <a href="https://discord.gg/HTXmrjvsDy">Discord</a> •
    <a href="https://twitter.com/rstagi_">Twitter</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/agentified"><img src="https://img.shields.io/npm/v/agentified?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://pypi.org/project/agentified/"><img src="https://img.shields.io/pypi/v/agentified?label=pypi&color=3775A9" alt="pypi" /></a>
    <a href="https://github.com/agentified/agentified/stargazers"><img src="https://img.shields.io/github/stars/agentified/agentified?style=social" alt="stars" /></a>
    <a href="https://discord.gg/HTXmrjvsDy"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da" alt="discord" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-SUL%20%2B%20MIT-blue" alt="license" /></a>
  </p>
</div>

> **86% cost reduction. Same task accuracy.** [Benchmarks →](./benchmarks/context-base/README.md)

<br />

## What is Agentified?

A **context engine** that registers all your tools, then uses hybrid semantic + BM25 ranking to select exactly the right ones for each query. Not another agent framework — a context layer that plugs into whatever you're already using.

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Your Agent  │ ──▶ │  agentified-core │ ──▶ │    OpenAI     │
│  (TS / Py)   │     │  (Rust server)   │     │  Embeddings   │
└─────────────┘     └────────┬─────────┘     └───────────────┘
                             │
                    Embeds, ranks & caches
```

1. **Register** your tools with name, description, and JSON schema
2. **Discover** with natural language — get the top-K tools ranked by relevance
3. **Execute** only what matters — the rest stays out of the context window

<br />

## Quick Start

### TypeScript

```bash
pnpm add agentified
```

```typescript
import { Agentified } from "agentified";

const ag = new Agentified();
await ag.connect("http://localhost:9119");

const dataset = await ag.dataset("my-agent").register({
  tools: [
    { name: "get_weather", description: "Get current weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, handler: async (args) => ({ temp: 22 }) },
    { name: "search_docs", description: "Search documentation", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, handler: async (args) => ({ results: [] }) },
  ],
});

// dataset.discoverTool — agent-callable tool discovery
// dataset.session(id)  — session-scoped tools + conversation
```

### Python

```bash
pip install agentified
```

```python
from agentified import Agentified, BackendTool, RegisterInput

ag = Agentified()
await ag.connect("http://localhost:9119")

instance = await ag.register(RegisterInput(tools=[
    BackendTool(name="get_weather", description="Get current weather",
                parameters={"type": "object", "properties": {"city": {"type": "string"}}},
                handler=lambda args: {"temp": 22, "city": args["city"]}),
]))
session = instance.session("my-session")
discovered = await session.discover_tool.execute({"query": "weather in Rome"})
# → [RankedTool(name="get_weather", score=0.92, ...)]
await ag.disconnect()
```

<br />

## Works with your stack

| TypeScript | Python |
|------------|--------|
| Mastra | LangGraph |
| AG-UI | LangChain |
| OpenAI SDK | OpenAI SDK |
| Any framework | Any framework |

**Zero lock-in.** Agentified handles tool selection. Your framework handles everything else.

<br />

## Why Agentified?

| Problem | Without Agentified | With Agentified |
|---------|-------------------|-----------------|
| **Tool selection** | Dump all tools in prompt | Hybrid-ranked selection based on intent |
| **Token costs** | Pay for irrelevant tools | Only load what's needed |
| **Multi-turn context** | No memory across turns | Session continuity via turn tracking |
| **Framework switching** | Rebuild context layer | Plug and play |
| **Context debugging** | Black box | Inspector with full visibility |

<br />

## Features

**[Hybrid Ranking](./docs/server/ranking.md)** — Semantic similarity (70%) + BM25 keyword matching (30%) across tool name, description, and schemas.

**[Session Continuity](./docs/server/session-continuity.md)** — Capture turns to track tool usage. Previously-used tools are prioritized automatically.

**[Graph Expansion](./docs/server/graph-expansion.md)** — Tools declare `requires`/`provides` metadata. Dependencies are auto-injected.

**[Frontend Tools](./docs/typescript/frontend-tools.md)** — Tag tools with `metadata.location: "frontend"` to run them client-side. Built-in React Inspector for debugging.

**[Storage](./docs/server/storage.md)** — In-memory default, SQLite WAL for persistence. Async write-through, zero-config.

**Framework Agnostic** — Works with Mastra, LangGraph, AG-UI, or raw API calls. TypeScript and Python.

**Rust Core** — Axum HTTP server, RwLock concurrency, content-hash embedding cache. Runs anywhere — local, Docker, serverless.

<br />

## Documentation

Full docs live in [`docs/`](./docs/):

- **[Getting Started (TypeScript)](./docs/typescript/getting-started.md)** — Paste-and-run TS example
- **[Getting Started (Python)](./docs/python/getting-started.md)** — Paste-and-run Python example
- **[Architecture](./docs/server/architecture.md)** — System design, ranking algorithm, storage
- **[Mastra Guide](./docs/typescript/integrations/mastra.md)** — Full-stack TypeScript example
- **[LangGraph Guide](./docs/python/integrations/langgraph.md)** — Python + Gemini example

<br />

## Try it now

### Run locally

```bash
# Start the server
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core

# Install and run (TypeScript)
pnpm add agentified
pnpm tsx index.ts  # see docs/typescript/getting-started.md for the code
```

### Sandbox

See Agentified in action. Compare token usage with and without smart tool selection.

[**Open the Sandbox →**](https://agentified.dev/sandbox)

### Examples

| Example | What it shows | Complexity |
|---------|---------------|------------|
| [ts-sdk-smoke](./examples/ts-sdk-smoke) | TS SDK basics — register, discover, sessions | Minimal |
| [ts-mastra-smoke](./examples/ts-mastra-smoke) | Mastra + OpenAI — LLM tool calling, AG-UI | Minimal |
| [py-sdk-smoke](./examples/py-sdk-smoke) | Python SDK basics — register, discover, sessions | Minimal |
| [py-langchain-sdk-smoke](./examples/py-langchain-sdk-smoke) | LangChain + OpenAI — LLM tool calling | Minimal |
| [QuickHR](./examples/quickhr) | Full-stack Mastra + React app | Full |
| [LangGraph Agent](./examples/py-langgraph) | LangGraph + Gemini (Python) | Full |

<br />

## Benchmarks

| Metric | Baseline | Agentified | Improvement |
|--------|----------|------------|-------------|
| Task Correctness | 0.98 | 0.98 | — |
| Avg. Tokens/Request | 45,000 | 6,200 | **-86%** |
| Cost per 1K queries | $21.53 | $2.95 | **-86%** |
| Latency (p50) | 2.1s | 1.4s | **-33%** |

[Full benchmark methodology →](./benchmarks/context-base/README.md)

<br />

## Community

- [Discord](https://discord.gg/HTXmrjvsDy) — Questions, feedback, and show & tell
- [Twitter](https://twitter.com/rstagi_) — Updates and announcements
- [AI Aperitivo](https://aiaperiti.vo) — Meet us IRL in Milan, Rome, and beyond
- [Contributing](./CONTRIBUTING.md) — We welcome PRs!

<br />

## License

`src/core/` is licensed under the [Sustainable Use License](./LICENSE.md#sustainable-use-license). All other packages (SDKs, React, examples) are [MIT](./LICENSE.md#mit-license). See [LICENSE.md](./LICENSE.md) for details.

---

<div align="center">
  <p>Built with ❤️ in Italy 🇮🇹</p>
  <p>
    <a href="https://agentified.dev">Website</a> •
    <a href="./docs/">Documentation</a> •
    <a href="https://github.com/agentified/agentified">GitHub</a>
  </p>
</div>
