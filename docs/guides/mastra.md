# Guide: Mastra + Agentified + React

Build a full-stack AI agent with Mastra, Agentified context resolution, React frontend tools, and the Inspector debug panel. Based on the [QuickHR example](../../examples/quickhr/).

## Architecture

```mermaid
graph LR
    A[React App<br/>@agentified/react] -->|AG-UI stream| B[Fastify Backend<br/>@agentified/mastra]
    B -->|register + discover| C[agentified-core<br/>Rust]
    C -->|embed| D[OpenAI]

    style C fill:#2563eb,color:#fff
```

- **React** — UI + frontend tool handlers + Inspector
- **Fastify** — AG-UI streaming endpoint, Mastra agent, Agentified adapter
- **agentified-core** — tool registry + hybrid ranking

## 1. Backend Setup

### Install

```bash
npm install @agentified/sdk @agentified/mastra @mastra/core fastify @fastify/cors
```

### Define tools

```typescript
// tools.ts
import { tool } from "@agentified/sdk";

export const sdkTools = [
  tool({
    name: "list_employees",
    description: "List all employees",
    parameters: { type: "object", properties: {} },
  }),
  tool({
    name: "navigate_to_page",
    description: "Navigate to a page in the app",
    parameters: { type: "object", properties: { page: { type: "string", enum: ["dashboard", "employees", "timeoff"] } }, required: ["page"] },
    metadata: { location: "frontend" },
  }),
];

export const toolHandlers: Record<string, (args: any) => Promise<unknown>> = {
  list_employees: async () => {
    const res = await fetch("http://localhost:3003/api/employees");
    return res.json();
  },
};
```

### Wire up the agent

```typescript
// index.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Agent } from "@mastra/core/agent";
import { AgentifiedMastra, streamSSE } from "@agentified/mastra";
import { sdkTools, toolHandlers } from "./tools.js";

const agent = new Agent({
  name: "my-agent",
  instructions: "You are a helpful HR assistant.",
  model: "google/gemini-3-flash-preview",
});

const agentified = new AgentifiedMastra({
  agentifiedUrl: "http://localhost:9119",
  tools: sdkTools,
  toolHandlers,
  agent,
});

const app = Fastify();
await app.register(cors, { origin: "*" });
await agentified.register();

app.post("/api/chat", async (req, reply) => {
  const { messages, forwardedProps } = req.body as any;
  const observable = await agentified.run({
    messages: messages ?? [],
    frontendTools: forwardedProps?.availableFrontendTools,
  });
  return streamSSE(observable, reply.raw);
});

app.listen({ port: 3003 });
```

The `run()` method handles the full cycle: prefetch → hydrate tools (JSON Schema → Zod) → agent.generate → AG-UI events → capture turn.

## 2. Frontend Setup

### Install

```bash
npm install @agentified/react @agentified/fe-client react
```

### App with Provider + Inspector

```tsx
import { AgentifiedProvider, Inspector, useAgentified, useAgentifiedTool } from "@agentified/react";

function FrontendTools() {
  useAgentifiedTool("navigate_to_page", async (args) => {
    window.location.href = `/${args.page}`;
    return { navigated: true };
  });
  return null;
}

function Chat() {
  const { messages, sendMessage, isLoading } = useAgentified();
  return (
    <div>
      {messages.map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      <button onClick={() => sendMessage("Show employees")} disabled={isLoading}>
        Send
      </button>
    </div>
  );
}

export function App() {
  return (
    <AgentifiedProvider agentUrl="http://localhost:3003/api/chat">
      <FrontendTools />
      <Chat />
      <Inspector defaultOpen />
    </AgentifiedProvider>
  );
}
```

## 3. Run

```bash
# Terminal 1: agentified-core
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core

# Terminal 2: Backend
npx tsx index.ts

# Terminal 3: Frontend
npx vite
```

## What Happens

1. Backend registers all tools with agentified-core (embeddings computed + cached)
2. User sends "Show employees" via React chat
3. Backend calls `agentified.run()` → prefetch discovers `list_employees` + `navigate_to_page`
4. Mastra agent generates with hydrated tools, calls `list_employees` (backend) and `navigate_to_page` (frontend)
5. Frontend client intercepts `navigate_to_page`, runs handler, injects result back
6. Inspector shows prefetch results, tool calls, timing, token usage

## See Also

- [QuickHR example source](../../examples/quickhr/) — Complete working example
- [Frontend Tools](../concepts/frontend-tools.md) — How frontend tool interception works
- [@agentified/mastra README](../../src/ts-packages/mastra/README.md) — Full API reference
- [@agentified/react README](../../src/ts-packages/react/README.md) — Provider, hooks, Inspector API
