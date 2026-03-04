<div align="center">
  <img src="https://agentified.dev/assets/logo-new-CNqV8zpW.png" alt="Agentified" height="80" />

  <h3>The context engine for AI agents</h3>
  <p>Smart tool selection for any framework. TypeScript & Python.</p>

  <p>
    <a href="https://agentified.dev/docs">Docs</a> •
    <a href="https://agentified.dev/sandbox">Sandbox</a> •
    <a href="https://discord.gg/HTXmrjvsDy">Discord</a> •
    <a href="https://twitter.com/rstagi_">Twitter</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@agentified/sdk"><img src="https://img.shields.io/npm/v/@agentified/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://pypi.org/project/agentified/"><img src="https://img.shields.io/pypi/v/agentified?label=pypi&color=3775A9" alt="pypi" /></a>
    <a href="https://github.com/agentified/agentified/stargazers"><img src="https://img.shields.io/github/stars/agentified/agentified?style=social" alt="stars" /></a>
    <a href="https://discord.gg/HTXmrjvsDy"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da" alt="discord" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

<br />

## What is Agentified?

Your AI agent has hundreds of tools — but the LLM can only handle a few at a time. Agentified is a **context engine** that registers all your tools, then uses hybrid semantic + BM25 ranking to select exactly the right ones for each query.

> **86% cost reduction. Same task accuracy.** [See benchmarks →](https://agentified.dev/benchmarks)

Agentified is **not another agent framework**. It's a context layer that plugs into whatever you're already using — Mastra, LangGraph, or raw API calls.

<br />

## How it works

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

// Discover relevant tools for a conversation
const ranked = await agent.prefetch({
  messages: [{ role: "user", content: "What's the weather in Rome?" }],
});
// → [{ name: "get_weather", score: 0.92, ... }]
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

    ranked = await agent.prefetch(
        messages=[{"role": "user", "content": "What's the weather in Rome?"}],
    )
    # → [RankedTool(name="get_weather", score=0.92, ...)]
```

<br />

## Works with your stack

Agentified integrates with the frameworks you already use:

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

[Read the full benchmarks →](https://agentified.dev/benchmarks)

<br />

## Features

🧠 **Hybrid Ranking**
Combines semantic similarity (70%) with BM25 keyword matching (30%) across tool name, description, and schemas. [Learn more →](https://agentified.dev/docs/resolution)

🔌 **Framework Agnostic**
Works with Mastra, LangGraph, AG-UI, or raw API calls. TypeScript and Python. [See integrations →](https://agentified.dev/docs/integrations)

💾 **Persistent Memory**
SQLite built-in for zero-config persistence of tools, turns, and embedding cache. [Configure storage →](https://agentified.dev/docs/storage)

⚡ **Rust Core**
Lightweight and fast. Embeds via OpenAI `text-embedding-3-small` with content-hash caching. Runs anywhere — local, Docker, serverless.

🖥️ **Frontend Tools & Inspector**
Tag tools with `metadata.location: "frontend"` to run them client-side. Built-in React Inspector for debugging prefetch, discovery, and token usage.

🔄 **Session Continuity**
Capture turns to track which tools were used. Previously-used tools are prioritized automatically on the next query.

<br />

## Try it now

### 🎮 Sandbox

See Agentified in action. Compare token usage with and without smart tool selection.

[**Open the Sandbox →**](https://agentified.dev/sandbox)

### 📚 Examples

| Example | Framework | Language |
|---------|-----------|----------|
| [QuickHR](./examples/quickhr) | Mastra + React | TypeScript |
| [LangGraph Agent](./examples/py-langgraph) | LangGraph + Gemini | Python |

<br />

## Benchmarks

Tested on real-world agent tasks with production workloads:

| Metric | Baseline | Agentified | Improvement |
|--------|----------|------------|-------------|
| Task Correctness | 0.98 | 0.98 | — |
| Avg. Tokens/Request | 45,000 | 6,200 | **-86%** |
| Cost per 1K queries | $21.53 | $2.95 | **-86%** |
| Latency (p50) | 2.1s | 1.4s | **-33%** |

[Full benchmark methodology →](https://agentified.dev/benchmarks)

<br />

## Community

We're building Agentified in the open. Join us:

- 💬 [Discord](https://discord.gg/HTXmrjvsDy) — Questions, feedback, and show & tell
- 🐦 [Twitter](https://twitter.com/rstagi_) — Updates and announcements
- 📍 [AI Aperitivo](https://aiaperiti.vo) — Meet us IRL in Milan, Rome, and beyond
- 🤝 [Contributing](./CONTRIBUTING.md) — We welcome PRs!

<br />

## License

[MIT](./LICENSE) — Use it however you want.

---

<div align="center">
  <p>Built with ❤️ in Italy 🇮🇹</p>
  <p>
    <a href="https://agentified.dev">Website</a> •
    <a href="https://agentified.dev/docs">Documentation</a> •
    <a href="https://github.com/agentified/agentified">GitHub</a>
  </p>
</div>
