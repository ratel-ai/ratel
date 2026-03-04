# @agentified/react

React bindings for [Agentified](../../README.md) — Provider, hooks, and a built-in Inspector debug panel.

## Install

```bash
npm install @agentified/react @agentified/fe-client
```

**Peer dependencies:** `react >= 18`

## Quick Start

```tsx
import { AgentifiedProvider, useAgentified, useAgentifiedTool, Inspector } from "@agentified/react";

function App() {
  return (
    <AgentifiedProvider agentUrl="http://localhost:3003/api/chat">
      <Chat />
      <Inspector defaultOpen />
    </AgentifiedProvider>
  );
}

function Chat() {
  const { messages, sendMessage, isLoading } = useAgentified();

  useAgentifiedTool("navigate_to_page", async (args) => {
    window.location.href = args.path;
    return { success: true };
  });

  return (
    <div>
      {messages.map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      <button onClick={() => sendMessage("Hello!")} disabled={isLoading}>
        Send
      </button>
    </div>
  );
}
```

## API Reference

### `<AgentifiedProvider>`

Wraps your app and provides the Agentified client context.

```tsx
interface AgentifiedProviderProps {
  agentUrl: string;                    // AG-UI agent backend URL
  headers?: Record<string, string>;    // custom HTTP headers
  children: React.ReactNode;
}

<AgentifiedProvider agentUrl="http://localhost:3003/api/chat">
  {children}
</AgentifiedProvider>
```

### `useAgentified()`

Main hook — returns messages, actions, and state.

```typescript
const {
  state,        // InspectorState — full client state
  messages,     // Message[] — conversation history
  sendMessage,  // (content: string) => Promise<void>
  isLoading,    // boolean
  error,        // string | null
  reset,        // () => void — clear all state
} = useAgentified();
```

### `useAgentifiedTool(name, handler)`

Registers a frontend tool handler. Automatically unregisters on unmount.

```typescript
useAgentifiedTool("open_modal", async (args) => {
  setModalOpen(args.id);
  return { opened: true };
});
```

### `useAgentifiedClient()`

Returns the raw `AgentifiedClient` instance for advanced use cases.

```typescript
const client = useAgentifiedClient();
client.setSharedContext({ page: "/dashboard", openModals: [] });
```

### `<Inspector>`

Floating debug panel with three tabs: **Timeline**, **Session**, and **Log**.

```tsx
interface InspectorProps {
  defaultOpen?: boolean;  // default: false
}

<Inspector defaultOpen />
```

**Timeline tab** — run status, interaction timeline (prefetch, discover, tool calls, messages), active tools, frontend tools, shared context.

**Session tab** — metrics grid (messages, tool calls, TTFT, duration, tokens), token breakdown, prefetch/discovery history.

**Log tab** — filterable event log (all / agentified / tool_calls / messages) with expandable event details.

The Inspector is draggable and resizable.

## Links

- [Root README](../../../README.md)
- [Frontend Client](../fe-client/README.md) — underlying client library
- [TypeScript SDK](../sdk/README.md)
- [Mastra Adapter](../mastra/README.md)
- [QuickHR Example](../../../examples/quickhr/) — full-stack app using all React bindings

## License

[MIT](../../../LICENSE.md#mit-license)
