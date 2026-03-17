# Overview

## The Problem

AI agents are getting more capable. They connect to databases, call APIs, manage files, send emails, book meetings — you name it. A production agent can easily have 50, 100, even 200+ tools available.

But here's the catch: **every tool you give to an LLM costs tokens**. Tool definitions — names, descriptions, parameter schemas — get serialized into the prompt. More tools means more tokens, higher latency, higher cost, and paradoxically, worse accuracy. The LLM gets overwhelmed and starts picking the wrong tools or hallucinating parameters.

Most teams solve this by manually curating tool subsets per agent, per use case, per turn. It works until it doesn't — and it never scales.

## What Agentified Does

Agentified is a **context intelligence layer**. It sits between your agent and its tools, and for each turn of conversation, it figures out which tools the agent actually needs — then delivers exactly those.

You register all your tools once. On every turn, you call `session.context.assemble()`. Agentified returns a small, ranked set of relevant tools plus conversation history, ready to pass to your LLM. That's it.

It's not an agent framework. It doesn't replace Mastra, LangGraph, LangChain, or whatever you're using. It plugs into them.

## How It Works

```
Your Agent (any framework)
        │
        │  session.context.assemble()
        ▼
  Agentified SDK (TypeScript / Python)
        │
        │  register + discover
        ▼
  agentified-core (Rust server)
        │
        │  embed + rank + expand
        ▼
  Only the right tools, every turn
```

Three steps:

1. **Register** — You give Agentified your full tool catalog. The server computes embeddings for each tool's name, description, and schemas, then indexes them for fast retrieval.

2. **Assemble** — On each agent turn, Agentified takes the user's message (or conversation context) and runs a hybrid ranking algorithm — combining semantic similarity with keyword matching — to score every tool against the current intent. It returns the top matches.

3. **Execute** — You pass the assembled context (tools + messages) to your agent framework. Your framework calls the tools as usual. Agentified tracks which tools were used so it can prioritize them in subsequent turns.

## What Makes the Ranking Smart

Agentified doesn't just do a keyword search. It uses a **hybrid approach**:

- **Semantic similarity (70%)** — Understands intent. "Cancel my subscription" finds `process_refund` even though the words don't overlap. Powered by OpenAI embeddings across four tool fields (description, input schema, name, output schema), each weighted by importance.

- **Keyword matching (30%)** — Catches exact terms the embedding model might underweight. "PTO" matches `get_pto_balance` directly.

On top of ranking, two more mechanisms kick in:

- **Session continuity** — If the agent used `get_employee_details` in turn 1, it stays available in turn 2. No context amnesia mid-conversation.

- **Graph expansion** — If a selected tool declares it *requires* another tool's output, that dependency gets auto-injected. You define the relationships once; Agentified handles the wiring.

## The Numbers

We benchmarked Agentified against a baseline of dumping all tools into the prompt on a 200-tool HR agent scenario:

| Metric | All tools in prompt | With Agentified |
|--------|---------------------|-----------------|
| Task correctness | 98% | 98% |
| Tokens per request | 45,000 | 6,200 |
| Cost per 1K queries | $21.53 | $2.95 |
| Latency (p50) | 2.1s | 1.4s |

**86% fewer tokens. 86% lower cost. 33% faster. Same accuracy.**

The savings compound: fewer tokens means cheaper API calls, faster responses, and more headroom before hitting context limits.

## What You Get

**SDKs for TypeScript and Python** — Fluent API that wraps the server. Register tools, create sessions, assemble context in one call. Async-first, with a sync Python wrapper available.

**Framework adapters** — Native integrations for Mastra (TypeScript) and LangChain/LangGraph (Python). Assembled tools come back as framework-native objects — no conversion needed.

**React components** — Provider, hooks, and a visual Inspector panel for debugging tool selection in real-time. See which tools were picked, their scores, and token estimates.

**Frontend tool execution** — Tag tools to run client-side in the browser. The SDK intercepts tool calls, runs them locally, and injects results back into the conversation.

**Runtime tool discovery** — An agent-callable tool that lets the LLM itself search for additional tools mid-conversation. Useful for open-ended workflows where the needed tools aren't predictable upfront.

**A fast Rust core** — The server is built with Axum, uses read-write locks for concurrent access, caches embeddings by content hash, and runs ranking in sub-milliseconds for hundreds of tools. Storage is in-memory by default, with optional SQLite persistence.

## Who It's For

**If you're building agents with more than a handful of tools**, Agentified saves you money and makes your agents faster without sacrificing accuracy.

- **Developers** building multi-tool agents who don't want to manually curate tool subsets per conversation turn.
- **Teams** running agents in production where token costs and latency matter.
- **Platform builders** offering agent capabilities to end users, where tool catalogs grow unpredictably.

If your agent has 5 tools, you probably don't need this. If it has 50+, you probably do.

## Get Started

Pick your language and you'll be running in under 5 minutes:

- **[TypeScript Getting Started](./typescript/getting-started.md)**
- **[Python Getting Started](./python/getting-started.md)**

Or jump straight to a framework integration:

- **[Mastra (TypeScript)](./typescript/integrations/mastra.md)**
- **[LangGraph (Python)](./python/integrations/langgraph.md)**

Want to see it in action first? **[Open the Demo](https://demo.agentified.dev)** — compare token usage with and without Agentified, side by side.
