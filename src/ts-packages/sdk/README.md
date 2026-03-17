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
const ctx = await session.context
  .tools({ custom_tool: myTool })     // inject explicit tools
  .messages({ strategy: "recent", maxTokens: 4000 })  // include conversation history
  .recall()                            // recall from memory (stub)
  .assemble();                         // → AssembledContext
```

### `AssembledContext<T>`

```typescript
interface AssembledContext<T> {
  tools: Record<string, T>;       // explicit + discovered tools
  messages: StoredMessage[];       // conversation messages
  recalled: unknown[];             // recalled memories (stub)
  strategyUsed: string;           // message strategy applied
  fallback: boolean;              // whether fallback was used
  tokenEstimate: number;          // estimated token count
  conversationMessages: number;   // total in conversation
  totalMessages: number;          // total messages stored
  includedMessages: number;       // messages included in context
}
```

### `session.discoverTool`

Agent-callable tool for runtime discovery. The agent can call this to find relevant tools on-the-fly.

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
