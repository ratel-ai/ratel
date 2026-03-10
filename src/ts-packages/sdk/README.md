# @agentified/sdk

TypeScript SDK for [Agentified](../../README.md) — register tools, discover relevant ones via hybrid ranking, and track sessions across turns.

## Install

```bash
npm install @agentified/sdk
```

## Quick Start

```typescript
import { ApiClient, tool } from "@agentified/sdk";

const agent = new ApiClient({
  serverUrl: "http://localhost:9119",
  tools: [
    tool({ name: "get_weather", description: "Get current weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }),
    tool({ name: "book_flight", description: "Book a flight", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } }),
  ],
});

await agent.register();

const ranked = await agent.prefetch({
  messages: [{ role: "user", content: "What's the weather in Rome?" }],
});
// → [{ name: "get_weather", score: 0.92, ... }, ...]
```

## API Reference

### `tool(definition)`

Creates a `ServerTool` with auto-populated `fields` for embedding.

```typescript
import { tool } from "@agentified/sdk";

const t = tool({
  name: "search_docs",
  description: "Search documentation by keyword",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  metadata: { category: "search" }, // optional
});
```

### `new ApiClient(config)`

```typescript
interface ApiClientConfig {
  serverUrl: string;
  tools: ServerTool[];
  onEvent?: (event: AgentifiedEvent) => void;
}
```

### `agent.register()`

Registers all tools with the server. Embeddings are computed and cached server-side.

```typescript
const result = await agent.register();
// { registered: 10 }
```

### `agent.prefetch(options)`

Discovers relevant tools for a conversation. Joins all message contents (newline-separated) as the discovery query.

```typescript
interface PrefetchOptions {
  messages: Message[];
  limit?: number;       // default 5
  exclude?: string[];
  turnId?: string;      // for session continuity
}

const tools = await agent.prefetch({
  messages: [{ role: "user", content: "Book me a flight to Paris" }],
  limit: 10,
  exclude: ["admin_tool"],
  turnId: "prev-turn-id",
});
```

### `agent.captureTurn(options)`

Captures a turn for session continuity. The returned `turnId` can be passed to subsequent `prefetch`/`discover` calls.

```typescript
const { turnId } = await agent.captureTurn({
  toolsLoaded: ["get_weather", "book_flight"],
  message: "What's the weather in Rome?",
});
```

### `agent.getFrontendTools()`

Returns tools with `metadata.location === "frontend"`.

```typescript
const frontendTools = agent.getFrontendTools();
```

### `agent.getFrontendToolNames()`

Returns names of frontend tools.

```typescript
const names = agent.getFrontendToolNames();
// ["navigate_to_page", "open_modal"]
```

### `agent.asDiscoverTool()`

Returns a tool definition + execute function for `agentified_discover` — useful for giving the agent a tool that can discover more tools at runtime.

```typescript
const { definition, execute } = agent.asDiscoverTool();
// definition: { name: "agentified_discover", description: "...", parameters: { ... } }
// execute({ query: "...", limit: 5 }) → Promise<RankedTool[]>
```

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
- [agentified-core](../../core/README.md)
- [Frontend Client](../fe-client/README.md)
- [React Bindings](../react/README.md)
- [Mastra Adapter](../mastra/README.md)
- [Python SDK](../../py-packages/sdk/README.md)

## License

[MIT](../../../LICENSE.md#mit-license)
