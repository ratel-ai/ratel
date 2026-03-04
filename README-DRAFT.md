<div align="center">
  <img src="https://agentified.dev/assets/logo-new-CNqV8zpW.png" alt="Agentified" height="80" />

  <h3>The context engine for AI agents</h3>
  <p>Smart context resolution for any framework. TypeScript & Python.</p>

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

Your AI agent is only as good as its context. Agentified is a **context engine** that manages what your agent knows, when it knows it, and retrieves exactly what's needed — nothing more.

> **86% cost reduction. Same task accuracy.** [See benchmarks →](https://agentified.dev/benchmarks)

Agentified is **not another agent framework**. It's a context layer that plugs into whatever you're already using — LangChain, Mastra, Vercel AI SDK, or raw API calls.

<br />

## How it works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Your App  │ ──▶ │ Agentified  │ ──▶ │     LLM     │
└─────────────┘     └──────┬──────┘     └─────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │    Context Sources    │
              │  docs • APIs • memory │
              └───────────────────────┘
```

1. **Register** your context sources (docs, APIs, conversation history)
2. **Query** with natural language intent
3. **Get** exactly the context your agent needs — optimized for tokens

<br />

## Quick Start

### TypeScript

```bash
npm install @agentified/sdk
```

```typescript
import { Agentified } from '@agentified/sdk'

const agent = new Agentified()

// Register your context sources
agent.register('docs', './knowledge-base')
agent.register('api', myApiClient)

// Resolve context for any query
const context = await agent.resolve('How do I reset my password?')
// → Returns only relevant chunks, optimized for tokens

// Use with your favorite framework
const response = await llm.chat({
  messages: [
    { role: 'system', content: context.system },
    { role: 'user', content: 'How do I reset my password?' }
  ]
})
```

### Python

```bash
pip install agentified
```

```python
from agentified import Agentified

agent = Agentified()

# Register your context sources
agent.register('docs', './knowledge-base')
agent.register('api', my_api_client)

# Resolve context for any query
context = agent.resolve('How do I reset my password?')
# → Returns only relevant chunks, optimized for tokens

# Use with your favorite framework
response = llm.chat(
    messages=[
        {"role": "system", "content": context.system},
        {"role": "user", "content": "How do I reset my password?"}
    ]
)
```

<br />

## Works with your stack

Agentified integrates with the frameworks you already use:

| TypeScript | Python |
|------------|--------|
| LangChain.js | LangChain |
| Vercel AI SDK | LlamaIndex |
| Mastra | CrewAI |
| OpenAI SDK | OpenAI SDK |
| Any framework | Any framework |

**Zero lock-in.** Agentified handles context. Your framework handles everything else.

<br />

## Why Agentified?

| Problem | Without Agentified | With Agentified |
|---------|-------------------|-----------------|
| **Context selection** | Dump everything in prompt | Smart retrieval based on intent |
| **Token costs** | Pay for irrelevant context | 86% cost reduction |
| **Hallucinations** | No source grounding | Context-aware, verifiable responses |
| **Framework switching** | Rebuild context layer | Plug and play |
| **Context debugging** | Black box | Full visibility into what's retrieved |

[Read the full benchmarks →](https://agentified.dev/benchmarks)

<br />

## Features

🧠 **Smart Context Resolution**
Retrieves exactly what your agent needs based on intent, not just keywords. [Learn more →](https://agentified.dev/docs/resolution)

🔌 **Framework Agnostic**
Works with LangChain, Mastra, AI SDK, or raw API calls. TypeScript and Python. [See integrations →](https://agentified.dev/docs/integrations)

💾 **Persistent Memory**
SQLite built-in for zero-config, or bring your own store. [Configure storage →](https://agentified.dev/docs/storage)

⚡ **Rust Core**
Lightweight and fast. No heavy dependencies. Runs anywhere — local, serverless, edge.

📊 **Token Analytics**
See exactly what context is being used and how much you're saving. [View dashboard →](https://agentified.dev/docs/analytics)

🔒 **Context Boundaries**
Control what context is available to whom. Built for multi-tenant applications. [Set up boundaries →](https://agentified.dev/docs/boundaries)

<br />

## Try it now

### 🎮 Sandbox

See Agentified in action. Compare token usage with and without smart context resolution.

[**Open the Sandbox →**](https://agentified.dev/sandbox)

### 📚 Examples

| Example | Framework | Language |
|---------|-----------|----------|
| [Customer Support Agent](./examples/ts-mastra-support) | Mastra | TypeScript |
| [RAG with AI SDK](./examples/ts-ai-sdk-rag) | Vercel AI SDK | TypeScript |
| [Document Q&A](./examples/py-langchain-qa) | LangChain | Python |
| [Research Assistant](./examples/py-llamaindex-research) | LlamaIndex | Python |

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

- 💬 [Discord](https://discord.gg/agentified) — Questions, feedback, and show & tell
- 🐦 [Twitter](https://twitter.com/agentified) — Updates and announcements
- 📍 [AI Aperitivo](https://aiaperiti.vo) — Meet us IRL in Milan, Rome, and beyond
- 🤝 [Contributing](./CONTRIBUTING.md) — We welcome PRs!

<br />

## License

[Apache 2.0](./LICENSE) — Use it however you want.

---

<div align="center">
  <p>Built with ❤️ in Italy 🇮🇹</p>
  <p>
    <a href="https://agentified.dev">Website</a> •
    <a href="https://agentified.dev/docs">Documentation</a> •
    <a href="https://github.com/agentified/agentified">GitHub</a>
  </p>
</div>
