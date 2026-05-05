# @agentified/fe-client

Run agent tools in the browser. Stream everything.

Frontend client for [Agentified](../../../README.md) — connects to an AG-UI agent backend, handles streaming events, manages [frontend tool execution](../../../docs/typescript/frontend-tools.md), and exposes full inspector state.

## Install

```bash
npm install @agentified/fe-client
```

## Quick Start

```typescript
import { AgentifiedClient } from "@agentified/fe-client";

const client = new AgentifiedClient({
  agentUrl: "http://localhost:3003/api/chat",
});

// Subscribe to state changes
client.subscribe((state) => {
  console.log("Messages:", state.messages);
  console.log("Loading:", state.isLoading);
  console.log("Tools:", state.agentified.currentTools);
});

// Register a frontend tool handler
client.registerToolHandler("navigate_to_page", async (args) => {
  window.location.href = args.path;
  return { success: true };
});

// Send a message (streams AG-UI events from backend)
await client.sendMessage("Show me the dashboard");
```

## API Reference

### `new AgentifiedClient(config)`

```typescript
interface AgentifiedClientConfig {
  agentUrl: string;                    // AG-UI agent backend URL
  headers?: Record<string, string>;    // custom HTTP headers
  contextWindowSize?: number;          // reserved for future use
  maxEventLogSize?: number;            // reserved for future use
}
```

### `client.subscribe(listener)`

Subscribe to state changes. Returns an object with `unsubscribe()`.

```typescript
const sub = client.subscribe((state: InspectorState) => {
  // called on every state change
});
sub.unsubscribe();
```

### `client.sendMessage(content)`

Sends a user message and streams the agent response.

```typescript
await client.sendMessage("What employees are on leave?");
```

### `client.run(input)`

Lower-level: runs the agent with full message history and optional context.

```typescript
await client.run({
  messages: [{ role: "user", content: "Hello" }],
  context: [{ description: "Current page", value: "/dashboard" }],
});
```

`context` is `Context[]` from `@ag-ui/client`.

### `client.registerToolHandler(name, handler)`

Registers a frontend tool handler. When the agent calls this tool, the handler runs client-side.

```typescript
client.registerToolHandler("open_modal", async (args) => {
  openModal(args.modalId);
  return { opened: true };
});
```

### `client.unregisterToolHandler(name)`

```typescript
client.unregisterToolHandler("open_modal");
```

### `client.setSharedContext(ctx)`

Sets shared context (page, modals, active tab) sent with each agent request.

```typescript
client.setSharedContext({ page: "/employees", openModals: [], activeTab: "list" });
```

### `client.getMessages()`

Returns current message history.

### `client.getState()`

Returns the full `InspectorState` snapshot.

### `client.getAvailableFrontendToolNames()`

Returns names of registered frontend tool handlers.

### `client.reset()`

Resets all state (messages, events, tools, connection status).

## State Model

The client maintains an `InspectorState` that tracks everything:

```typescript
interface InspectorState {
  connection: ConnectionStatus;  // "idle" | "connecting" | "connected" | "disconnected" | "error"
  run: RunInfo;                  // runId, threadId, startedAt, durationMs
  agentified: {
    prefetchResults: PrefetchResult[];
    discoveries: DiscoveryResult[];
    currentTools: AgentifiedTool[];
  };
  tokens: TokenState;            // input, output, cached, reasoning, contextWindowPercent
  streaming: StreamingMetrics;   // messageCount, toolCallCount, timeToFirstTokenMs
  toolCalls: ToolCallDetail[];   // all tool calls with timing
  events: EventLogEntry[];       // full event log
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  frontendTools: string[];
  sharedContext?: SharedContext;
}
```

## Frontend Tool Handling

The client handles frontend tools automatically:

1. Agent calls a tool with `metadata.location === "frontend"`
2. Client intercepts it and runs the registered handler
3. Tool result is injected back into the conversation
4. Agent continues with up to 5 iterations of frontend tool calls

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [Frontend Tools concept](../../../docs/typescript/frontend-tools.md)
- [Mastra guide](../../../docs/typescript/integrations/mastra.md) — Full-stack example
- [React Bindings](../react/README.md) — React wrapper with Provider/hooks
- [TypeScript SDK](../sdk/README.md)
- [agentified-core](../../core/README.md)

## License

[MIT](../../../LICENSE.md#mit-license)
