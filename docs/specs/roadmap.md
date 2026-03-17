# Agentified Roadmap

**Status:** Draft
**Approach:** Each iteration delivers a complete, usable product. A developer can ship after any iteration.

---

## Iteration 1 — Raft: Persistent Conversations

**Value:** Agent conversations survive across requests — so `assemble()` can draw from full conversation history, not just the current message. New Agentified API established.

### Developer experience

```typescript
const ag = new Agentified();
await ag.connect();
const dataset = await ag.register({
  tools: [
    { name: 'lookup', description: '...', parameters: {...}, handler: lookupHandler },
  ],
});
const session = dataset.session(chatId);

await session.updateConversation({ messages: req.body.messages });
const { messages } = await session.context.messages({ strategy: 'recent' }).assemble();
const response = await agent.generate(messages, { prepareStep: session.prepareStep });
```

### Scope

| Layer | Work |
|-------|------|
| Rust core | Crate split (agentified-lib + agentified-server). Dataset-scoped tools. Messages table. POST/GET messages. Context endpoint (full + recent). GET /health. |
| @agentified/sdk | Dataset-scoped register, discover, prefetch. appendMessages, getMessages, getContext. |
| @agentified/mastra | Agentified, DatasetRef, Session (no Namespace yet). Unified tool model (`BackendTool` only — shape supports future types). `register({ tools })`. updateConversation + context builder (messages only, no recall). session.prepareStep (persists LLM messages). Local core auto-spawn. |
| Migration | AgentifiedMastra stays exported, deprecated. |

### Agent tools

| Tool | Status |
|------|--------|
| searchTools | Active |

### What we skip

Namespaces, memories, knowledge, artifacts, graph, summaries, recall, MCP tools, client tools, skills.

---

## Iteration 2 — Rowing Boat: Memory + Namespaces

**Value:** Agent remembers across conversations — so `assemble()` can recall relevant memories that inform which tools and context to surface. Multi-user isolation via namespaces.

### Developer experience

```typescript
const dataset = await ag.dataset("my-app").register({ tools: [...] });
const session = dataset.namespace(userId).session(chatId);

const agent = new Agent({
  tools: {
    searchTools: session.searchTools,
    remember: session.remember,
    recall: session.recall,
    getMessages: session.getMessages,
  },
  prepareStep: session.prepareStep,
});

const { messages } = await session.context
  .messages({ strategy: 'recent' })
  .recall({ memories: true })
  .assemble();
```

### Scope

| Layer | Work |
|-------|------|
| Rust core | Memories table (kind, embedding, scope columns). POST/DELETE /api/v1/memories. POST /api/v1/memories/search. Namespace column on messages table. Context endpoint extended: recall config for memories. |
| @agentified/sdk | Memory CRUD + search. Namespace parameter on all message methods. |
| @agentified/mastra | Namespace class. Sub-namespace hierarchy + ancestor chain visibility rules. `remember`, `recall`, `getMessages` agent tools. Context builder gains `.recall({ memories })`. Dataset scoping on Agentified. |

### Agent tools

| Tool | Status |
|------|--------|
| searchTools | Active |
| remember | **New** |
| recall | **New** |
| getMessages | **New** |

### What we skip

Knowledge, artifacts, graph, summaries, MCP tools, client tools, skills.

---

## Iteration 3 — Canoe: Summaries + Full Context Assembly

**Value:** Long conversations handled gracefully — so `assemble()` can reason over full conversation history, not just recent messages. The context builder is complete.

### Developer experience

```typescript
const { messages } = await session.context
  .messages({ strategy: 'recent+summary', maxTokens: 4000 })
  .recall({ tools: true, memories: true })
  .assemble();
// ctx includes: strategyUsed, summary, fallback fields
```

### Scope

| Layer | Work |
|-------|------|
| Rust core | `summary` + `recent+summary` context strategies (LLM integration via OpenAI). Summary cache keyed by `(dataset_id, namespace_id, session_id, max_seq)`. Fallback chain: LLM fail after 2 retries/15s -> fall back to `recent`, response includes `fallback: true`. OPENAI_API_KEY validation: 422 if missing for summary strategies. |
| @agentified/mastra | Full context builder with all strategies + all recall types. AssembledContext response with strategyUsed, summary, fallback fields. |

### Agent tools

Same as iteration 2 (searchTools, remember, recall, getMessages).

### Why separate

Summary generation is the first feature requiring **LLM-in-the-loop on the server side**. It introduces caching, fallback chains, and a new external dependency path. Isolating it lets us validate the simpler memory features without this complexity.

### What we skip

Graph, MCP tools, client tools, skills.

---

## Iteration 4 — Sailboat: MCP + Frontend Tools + Skills

**Value:** The unified tool model is complete — so `assemble()` can rank and route across backend, frontend, and MCP tools in a single call. Skills follow agentskills.io.

### Developer experience

```typescript
const dataset = await ag.register({
  tools: [
    // Backend — type inferred from handler
    { name: 'lookup', description: '...', parameters: {...}, handler: lookupHandler },

    // Frontend — no handler, explicit type
    { name: 'showChart', description: '...', parameters: {...}, type: 'client' },

    // MCP — via helper
    ...mcpTools({
      server: 'mcp://localhost:3001',
      tools: [{ name: 'read_file', description: '...', parameters: {...} }],
    }),
  ],
  skills: [
    {
      name: 'onboard-user',
      description: 'Full user onboarding. Use when a new user signs up.',
      instructions: '## Steps\n1. Call createAccount with the user email\n2. Call sendWelcomeEmail...',
      tools: ['createAccount', 'sendWelcomeEmail', 'setupDefaults'],
    },
  ],
});
```

### Scope

| Layer | Work |
|-------|------|
| Rust core | Tool `type` column in tools table. Skills table (instructions, referenced tools, embedding for discovery). POST/GET /api/v1/datasets/{id}/skills. Skill discovery: searchTools returns skills alongside tools. Validate skill's referenced tools exist at registration. |
| @agentified/sdk | MCP proxying (forward tool calls to MCP server URI). Frontend tool pass-through (AG-UI frontend tool calls). `mcpTools()` helper function. |
| @agentified/mastra | Tool routing in prepareStep: backend -> execute handler, client -> AG-UI, mcp -> proxy, skill -> inject instructions + load tools. Skill activation: when agent discovers a skill, system adds instructions to context and referenced tools to activeTools. `register({ tools, skills })`. |

### Agent tools

Same tools, but `searchTools` now returns skills alongside tools. When the agent selects a skill, the system injects its instructions into context and loads its referenced tools into the active set.

### Why separate

Each tool type has a different execution path (local handler vs AG-UI vs MCP proxy vs context injection). Skills need the "load referenced tools" behavior in prepareStep. This is meaningful complexity that benefits from focused iteration.

### What we skip

Graph, auto-inference, knowledge, artifacts.

---

## Iteration 5 — Motorboat: Graph + Intelligence

**Value:** The system builds a knowledge graph — so `assemble()` can follow entity relationships, not just semantic similarity, making recall and tool discovery structurally aware.

### Developer experience

```typescript
// Developer code barely changes — graph is system-managed
// Agent gains traverseGraph
const agent = new Agent({
  tools: {
    ...session.tools,  // now includes traverseGraph
    remember: session.remember,
  },
});

// recall() is now graph-aware — better results
const { messages } = await session.context
  .messages({ strategy: 'recent+summary', maxTokens: 4000 })
  .recall()  // uses graph traversal under the hood
  .assemble();
```

### Scope

| Layer | Work |
|-------|------|
| Rust core | Entities table (dataset-scoped). Relationships table (scoped). POST /api/v1/relationships. POST /api/v1/graph/traverse. GET /api/v1/entities/{id}. Auto-extraction: entity + relationship extraction from memories on write. Memory consolidation (supersede chain). Graph-aware recall: traverse relationships, not just vector search. |
| @agentified/mastra | `traverseGraph` agent tool (read-only). Graph-aware context assembly in `.recall()`. |

### Agent tools

| Tool | Status |
|------|--------|
| searchTools | Active |
| remember | Active |
| recall | Active (now graph-aware) |
| getMessages | Active |
| traverseGraph | **New** |

---

## Summary

| # | Name | Core value | How it makes `assemble()` smarter |
|---|------|-----------|-----------------------------------|
| 1 | **Raft** | Conversations persist | Draws from full conversation history, not just current message |
| 2 | **Rowing Boat** | Memory + multi-user | Recalls memories that inform tool and context selection |
| 3 | **Canoe** | Summaries + full assembly | Reasons over entire conversation via summaries, not just recent window |
| 4 | **Sailboat** | Unified tool model + skills | Ranks and routes across backend, frontend, MCP tools + skills in one call |
| 5 | **Motorboat** | Graph intelligence | Follows entity relationships for structurally-aware recall and discovery |

### Agent tools per iteration

| Tool | Iter 1 | Iter 2 | Iter 3 | Iter 4 | Iter 5 |
|------|--------|--------|--------|--------|--------|
| searchTools | Y | Y | Y | Y (+ skills) | Y |
| remember | — | Y | Y | Y | Y |
| recall | — | Y | Y | Y | Y (graph-aware) |
| getMessages | — | Y | Y | Y | Y |
| traverseGraph | — | — | — | — | Y |

---

## Future (not scheduled)

| Feature | Depends on | Notes |
|---------|-----------|-------|
| Knowledge primitive | Iteration 3+ | Complex infra (chunking, embeddings at scale). Skills cover procedural knowledge. Evaluate Cognee. |
| Artifact primitive | Iteration 2+ | Needs definition: storage format, referencing, chunking. Wait for real use cases. |
| Memory migration on tool changes | Iteration 5 | Agent discovers staleness organically for now. |
| Cross-namespace inference | Iteration 5 | "Users like this one tend to..." |
| Memory decay / relevance scoring | Iteration 5 | Recency + frequency weighting. |
| Skill learning | Iteration 4 | Agent composes new skills from tool usage patterns. |
| Instance lifecycle (heartbeat, GC, multi-process isolation) | Iteration 2+ | Deferred from Iter 1 — add when multi-agent-process sharing is needed |

---

## References

| Topic | Location |
|-------|----------|
| SDK spec | [client-sdk-spec.md](./client-sdk-spec.md) |
| Context layer spec | [context-layer-spec.md](./context-layer-spec.md) |
| Agent Skills specification | [agentskills.io/specification](https://agentskills.io/specification) |
