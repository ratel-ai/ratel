# agentified

Context intelligence for AI agents. Register tools, assemble the right context per turn.

TypeScript SDK for [Agentified](../../../README.md) — register tools, discover relevant ones via [hybrid ranking](../../../docs/server/ranking.md), and track [sessions](../../../docs/server/session-continuity.md) across turns.

## Install

```bash
npm install agentified
```

## Quick Start

```typescript
import { Agentified } from "agentified";

const ag = new Agentified();
await ag.connect("http://localhost:9119");

const dataset = await ag.dataset("my-agent").register({
  tools: [
    { name: "get_weather", description: "Get current weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, handler: async (args) => ({ temp: 22 }) },
    { name: "book_flight", description: "Book a flight", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] }, handler: async (args) => ({ booked: true }) },
  ],
});

const session = dataset.session("chat-1");

// Assemble context — tools + messages for this turn
const ctx = await session.context
  .messages({ strategy: "recent", maxTokens: 4000 })
  .assemble();
// ctx.tools     → { get_weather, book_flight } (ranked by relevance)
// ctx.messages  → conversation history
// ctx.tokenEstimate → estimated token count
```

See [ts-sdk-smoke](../../../examples/ts-sdk-smoke/) for a runnable version of this.

## Authentication

Pass custom headers (e.g. for Cloud Run IAM, API gateways) via `connect()`:

```typescript
await ag.connect("https://my-service.run.app", {
  headers: { Authorization: `Bearer ${identityToken}` },
});
```

Headers are sent on every request, including the initial health check.

## Hierarchy

```
Agentified
  ├─ .connect(serverUrl?, options?)  → void
  ├─ .adaptTo(adapter)   → T (framework-specific wrapper)
  └─ .dataset(name) → DatasetRef
       └─ .register({ tools }) → Instance
            ├─ .discoverTool     — DiscoverTool
            ├─ .prepareStep      — PrepareStepFn
            ├─ .session(id)      → Session
            │    ├─ .discoverTool
            │    ├─ .getMessagesTool — agent-callable tool for navigating conversation history
            │    ├─ .prepareStep (persists messages)
            │    ├─ .context.messages(opts).recall(opts).assemble()
            │    ├─ .updateConversation({ messages })
            │    ├─ .getMessages(opts)
            │    └─ .conversation → Conversation
            └─ .namespace(id)    → Namespace
                 ├─ .tools (stub)
                 └─ .session(id) → Session
```

## API Reference

## ContextBuilder

Fluent API for assembling context per agent turn. Access via `session.context`:

```typescript
// Basic: messages only
const ctx = await session.context
  .messages({ strategy: "recent", maxTokens: 4000 })
  .assemble();

// With tool recall: auto-discovers tools based on last user message
const ctx = await session.context
  .tools({ custom_tool: myTool })
  .messages({ strategy: "recent+summary", maxTokens: 4000 })
  .recall({ tools: { limit: 10 } })
  .limitTokens(8000)
  .assemble();

// Preserve the first user message + annotate summaries
const ctx = await session.context
  .messages({ strategy: "recent+summary", maxTokens: 4000, keepFirst: true, annotateSummary: true })
  .assemble();
// ctx.messages[0] → first user message (original prompt)
// Summary message content starts with "[Summary of messages 1–85 (85 messages compacted)]"
```

**Strategies:** `recent`, `full`, `summary`, `recent+summary`

- `summary` — LLM-summarizes conversation into a single system message
- `recent+summary` — recent messages (60% budget) + summary of older messages (40%)
- Falls back to `recent` if LLM fails (`fallback: true` in response)

**Message options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strategy` | `ContextStrategy` | `"recent"` | Message selection strategy |
| `maxTokens` | `number` | `4000` | Token budget for messages |
| `keepFirst` | `boolean` | `false` | Always include the first user message |
| `annotateSummary` | `boolean` | `true` | Wrap summaries with seq range metadata |

**Recall:** `.recall()` with no args defaults to `{ tools: true }`. Pass `{ tools: { limit, minSimilarity } }` for fine-grained control. Recalled tools persist within the session (session continuity).

**Token budget:** `.limitTokens(n)` caps total output (tools + messages). Tool token cost is subtracted from the message budget.

### `AssembledContext<T>`

```typescript
interface AssembledContext<T> {
  tools: Record<string, T>;       // explicit + discovered tools
  messages: StoredMessage[];       // conversation messages
  recalled: {                      // recalled context
    tools: RankedTool[];           // auto-discovered tools with scores
    memories: unknown[];           // reserved for future memory recall
  };
  strategyUsed: ContextStrategy;   // strategy applied
  fallback: boolean;               // true if LLM summary failed
  summary?: string;                // summary text (when using summary strategies)
  tokenEstimate: number;           // estimated token count
  conversationMessages: number;    // total in conversation
  totalMessages: number;           // total messages stored
  includedMessages: number;        // messages included in context
}
```

### `session.discoverTool`

Agent-callable tool for runtime discovery. The agent can call this to find relevant tools on-the-fly.

### `session.getMessagesTool`

Agent-callable tool for navigating conversation history. The agent can call this to retrieve messages that were summarized or excluded from the current context window.

```typescript
// Exposed as "agentified_get_messages" in prepareStep activeTools
// Parameters: { limit?: number, afterSeq?: number, aroundSeq?: number }
// Returns: { messages: StoredMessage[], hasMore: boolean, maxSeq: number }
```

Works with summary annotation — when the agent sees `[Summary of messages 1–85 (85 messages compacted)]`, it can call `getMessagesTool` with `afterSeq: 0, limit: 20` to read the compacted messages.

### `session.updateConversation({ messages })`

Persist messages with deduplication for multi-turn context.

### `session.getMessages(opts)`

Retrieve conversation history with strategy-based filtering.

## Events

Subscribe to lifecycle events via `onEvent` in the config:

```typescript
const agent = new ApiClient({
  serverUrl: "http://localhost:9119",
  tools: [...],
  onEvent: (event) => {
    switch (event.type) {
      case "agentified:prefetch:start":    // { messages }
      case "agentified:prefetch:complete": // { tools, durationMs, tokenUsage? }
      case "agentified:prefetch:skipped":  // { tools, durationMs }
      case "agentified:discover:start":    // { query }
      case "agentified:discover:complete": // { query, tools, durationMs, tokenUsage? }
    }
  },
});
```

## Types

```typescript
interface ServerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  fields?: { name: string; description: string; inputSchema?: string; outputSchema?: string };
}

interface RankedTool extends ServerTool {
  score: number;
  graphExpanded?: boolean;
}

interface Message {
  role: string;
  content: string;
}

interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
}
```

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [Architecture](../../../docs/server/architecture.md)
- [agentified-core](../../core/README.md)
- [Frontend Client](../fe-client/README.md)
- [React Bindings](../react/README.md)
- [Mastra Adapter](../mastra/README.md)
- [Python SDK](../../py-packages/sdk/README.md)
- [ts-sdk-smoke example](../../../examples/ts-sdk-smoke/) — runnable smoke test

## License

[MIT](../../../LICENSE.md#mit-license)
