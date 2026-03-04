# @agentified/mastra

[Mastra](https://mastra.ai) adapter for [Agentified](../../README.md) — wraps a Mastra agent with Agentified context resolution, dynamic tool hydration, and AG-UI streaming.

## Install

```bash
npm install @agentified/mastra @agentified/sdk
```

**Peer dependencies:** `@mastra/core >= 1.0.0`, `@ag-ui/client >= 0.0.45`, `@ag-ui/mastra >= 1.0.0`, `zod >= 3.0.0`

## Quick Start

```typescript
import { Agent } from "@mastra/core/agent";
import { AgentifiedMastra, streamSSE } from "@agentified/mastra";
import { tool } from "@agentified/sdk";

const agent = new Agent({ name: "my-agent", model: google("gemini-3-flash-preview"), instructions: "You are a helpful assistant." });

const agentified = new AgentifiedMastra({
  agentifiedUrl: "http://localhost:9119",
  tools: [
    tool({ name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }),
  ],
  toolHandlers: {
    get_weather: async ({ city }) => ({ temp: 22, unit: "C", city }),
  },
  agent,
});

await agentified.register();
```

## API Reference

### `new AgentifiedMastra(config)`

```typescript
interface AgentifiedMastraConfig {
  agentifiedUrl: string;
  tools: ServerTool[];
  toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  agent: { name: string; generate: (...args: any[]) => any; stream: (...args: any[]) => any };
}
```

The `agent` field accepts any object with `name`, `generate`, and `stream` — typically a `@mastra/core` `Agent` instance.

### `agentified.register()`

Registers tools with the Agentified server.

```typescript
await agentified.register();
```

### `agentified.generate(options)`

Runs a full generate cycle: prefetch → hydrate tools → agent.generate → capture turn.

```typescript
interface GenerateOptions {
  messages: Message[];
  maxSteps?: number;
  turnId?: string;       // session continuity
  toolLimit?: number;
  seed?: number;
  debug?: boolean;
  onStepFinish?: (event: { usage: any; toolCalls: any[] }) => void;
}

const result = await agentified.generate({
  messages: [{ role: "user", content: "What's the weather in Rome?" }],
  maxSteps: 5,
});

// result:
// {
//   text: "The weather in Rome is 22°C.",
//   toolCalls: [...],
//   steps: [...],
//   usage: { inputTokens, outputTokens, totalTokens },
//   hydratedTools: ["get_weather"],
//   turnId: "...",
//   durationMs: 1234,
// }
```

The `generate` flow:
1. **Prefetch** — discovers relevant tools for the conversation
2. **Hydrate** — converts ranked tools to Mastra tools (JSON Schema → Zod) and injects `agentified_discover` for runtime discovery
3. **Generate** — calls `agent.generate()` with a `prepareStep` callback that dynamically expands tools when the agent discovers more
4. **Capture turn** — stores the turn for session continuity

### `agentified.run(options)`

Returns a `Promise<Observable<BaseEvent>>` for AG-UI streaming — designed for use with the frontend client.

```typescript
interface RunOptions {
  messages: Array<{
    role: string;
    content: string;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }>;
  frontendTools?: string[];  // frontend tool names to exclude from prefetch
}

const observable = await agentified.run({
  messages: [{ role: "user", content: "Hello" }],
  frontendTools: ["navigate_to_page"],
});
```

### `streamSSE(observable, res)`

Pipes an AG-UI Observable into an HTTP SSE response.

```typescript
import { streamSSE } from "@agentified/mastra";
import http from "http";

http.createServer(async (req, res) => {
  const observable = await agentified.run({ messages });
  streamSSE(observable, res);
}).listen(3003);
```

SSE format: `data: <JSON>\n\n` per event, connection closes on stream completion.

### `jsonSchemaToZod(schema)`

Converts a JSON Schema object to a Zod schema. Used internally to hydrate Mastra tools from Agentified's JSON Schema parameters.

```typescript
import { jsonSchemaToZod } from "@agentified/mastra";

const zodSchema = jsonSchemaToZod({
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
});
```

Supports: `string`, `number`, `integer`, `boolean`, `array`, `object`, `enum`.

## Links

- [Root README](../../../README.md)
- [TypeScript SDK](../sdk/README.md)
- [Frontend Client](../fe-client/README.md)
- [React Bindings](../react/README.md)
- [QuickHR Example](../../../examples/quickhr/) — full Mastra + React app
