# Overview

Agentified is a context intelligence layer for AI agents. It **assembles the right tools, messages, and memory for each agent turn** as one interconnected system. Ultimately delivering up to **90% token reduction, lower latency and stable reliability**.

## The problem

AI agents need to correctly assembly context (*i.e., tools, messages, memories, user preferences and entity relationship*) for each turn. Most frameworks treat these as separate features. You wire up memory over here, tool selection over there, conversation history somewhere else. They don't talk to each other.

Most teams solve this by manually curating tool subsets and stitching context together per agent, per use case, per turn.

## Agentified's solution

1. You **register all your tools once** inside Agentified
2. On every turn, the agent calls `session.context.assemble()`
3. Agentified **returns exactly what your agent needs**: a ranked set of relevant tools, conversation history, and recalled context, **in a single call**

Every primitive Agentified stores exists because **it makes the next `assemble()` call smarter**:
 - Memories inform which tools surface
 - Tool usage creates memories
 - Session history shapes ranking 

As the system grows, entity relationships and knowledge graphs feed back into assembly too. Ultimately, **one call gets progressively more intelligent**.

**It's not an agent framework**. It doesn't replace Mastra, LangGraph, LangChain, or whatever you're using. **It plugs into all of them**, in TypeScript and Python alike.

## How It Works

```
Your Agent (any framework, any language)
        |
        |  session.context.assemble()
        v
  Agentified SDK (TypeScript / Python)
        |
        |  register + discover + recall
        v
  agentified-core (Rust server)
        |
        |  rank + expand + assemble
        v
  Only the right context, every turn
```

Three steps:

1. **Register** (*once*): You give Agentified your full tool catalog. The server computes embeddings for each tool's name, description, and schemas, then indexes them for fast retrieval.
2. **Assemble**: Agentified takes the conversation context and runs a **hybrid ranking algorithm** to score every tool against the current intent while **cross-referencing memories and session history** to refine results. With **tool recall**, the system auto-discovers relevant tools based on the last user message. **Message strategies** (`recent`, `full`, `compacted`) control how conversation history is assembled — the `compacted` strategy uses LLM summarization for older messages, with long tool results pruned before summarization. **Token budgets** via `.limitTokens()` cap total assembly output.
3. **Execute**: Agentified passes the assembled context (tools + messages) to your agent framework. Your framework calls the tools as usual. Agentified **tracks which tools were used so it can prioritize them in subsequent turns**.

## What Makes the Ranking Smart

**Hybrid ranking algorithm**:

- **Semantic similarity (70%)**: Understands intent. "Cancel my subscription" finds `process_refund` even though the words don't overlap. Powered by OpenAI embeddings across four tool fields (description, input schema, name, output schema), each weighted by importance
- **Keyword matching (30%)**: Catches exact terms the embedding model might underweight. "PTO" matches `get_pto_balance` directly

**Two more mechanisms make your agent smarter**:

- **Session continuity**: If the agent used `get_employee_details` in turn 1, it stays available in turn 2. No context amnesia mid-conversation.
- **Graph expansion**: If a selected tool declares it *requires* another tool's output, that dependency gets auto-injected. You define the relationships once; Agentified handles the wiring.

## A real example

Benchmarked on a 200-tool HR agent, against loading all tools into the prompt (Claude Opus 4.6):

Same accuracy — and massively fewer resources:

| Metric | All tools in prompt | With Agentified |
|--------|---------------------|-----------------|
| Input tokens | 3.8M | 563K |
| Cost | $19.88 | $3.32 |
| Latency | 614s | 549s |

**85% fewer tokens. 83% lower cost. 10% faster.**

## Why do we win against your framework's existing memory?

**Interconnected, not co-located.** Every primitive feeds into `assemble()`. Memories influence which tools surface. Tool usage patterns inform future recall. Session history shapes ranking. The graph connects entities across all of them. **It's one system that gets smarter as a whole, not a bag of features that happen to live in the same library**.

**Framework and language agnostic.** Agentified works with Mastra, LangGraph, LangChain, the raw OpenAI SDK, or anything else, in TypeScript and Python. You get the same context intelligence regardless of your stack. **No lock-in to a single framework or language**.

## What You Get

- *SDKs for TypeScript and Python*: Fluent API that wraps the server. Register tools, create sessions, and assemble context in one call. Async-first, with a sync Python wrapper available.

- *Framework adapters*: Native integrations for Mastra (TypeScript) and LangChain/LangGraph (Python). Assembled tools come back as framework-native objects — no conversion needed. More framework adapters coming soon.

- *React components*: Provider, hooks, and a visual Inspector panel for debugging tool selection in real-time. See which tools were picked, their scores, and token estimates.

- *Frontend tool execution*: Tag tools to run client-side in the browser. The SDK intercepts tool calls, runs them locally, and injects results back into the conversation.

- *Runtime tool discovery*: An agent-callable tool that lets the LLM itself search for additional tools mid-conversation. Useful for open-ended workflows where the needed tools aren't predictable upfront.

- *A fast Rust core*: The server is built with Axum, uses read-write locks for concurrent access, caches embeddings by content hash, and runs ranking in sub-milliseconds for hundreds of tools. Storage is in-memory by default, with optional SQLite persistence and more storage backends coming soon.

## Who It's For

- *Developers* building multi-tool agents who don't want to manually curate tool subsets and stitch context together per conversation turn.
- *Teams* running agents in production where token costs and latency matter.
- *Platform builders* offering agent capabilities to end users, where tool catalogs grow unpredictably.
- *Multi-framework / multi-language teams* that need consistent context intelligence across TypeScript and Python agents without locking into a single stack.

## Get Started

Pick your language and you'll be running in under 5 minutes:

- **[TypeScript Getting Started](./typescript/getting-started.md)**
- **[Python Getting Started](./python/getting-started.md)**

Or jump straight to a framework integration:

- **[Mastra (TypeScript)](./typescript/integrations/mastra.md)**
- **[LangGraph (Python)](./python/integrations/langgraph.md)**

Want to see it in action first? **[Open the Demo](https://demo.agentified.dev)** — compare token usage with and without Agentified, side by side.side.
