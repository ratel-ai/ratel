# @agentified/mastra

Mastra adapter layer for [Agentified](../../../README.md) — wraps SDK classes with Mastra-typed shells via composition, plus AG-UI streaming. See the [Mastra guide](../../../docs/guides/mastra.md) for a full-stack walkthrough.

## Install

```bash
npm install @agentified/mastra agentified
```

**Peer dependencies:** `@mastra/core >= 1.0.0`, `@ag-ui/client >= 0.0.45`, `@ag-ui/mastra >= 1.0.0`, `zod >= 3.0.0`

## Quick Start

```typescript
import { Agent } from "@mastra/core/agent";
import { Agentified } from "agentified";
import { mastra } from "@agentified/mastra";
import { openai } from "@ai-sdk/openai";

const ag = new Agentified().adaptTo(mastra());
await ag.connect("http://localhost:9119");

const dataset = await ag.dataset("my-agent").register({
  tools: [
    { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, handler: async (args) => ({ temp: 22 }) },
  ],
});

const agent = new Agent({
  name: "my-agent",
  model: openai("gpt-4o-mini"),
  instructions: "You are a helpful assistant.",
  tools: { discoverTool: dataset.discoverTool },  // Mastra createTool
  prepareStep: dataset.prepareStep,
});
```

> **Note:** `@ai-sdk/openai` must be `^3.0.0` (AI SDK v4). Mastra 1.11+ rejects v1.x.

## Adapter Pattern

The `mastra()` factory returns an adapter for `Agentified.adaptTo()`. This wraps SDK classes in Mastra-typed shells via composition (not inheritance):

```
Agentified.adaptTo(mastra()) → MastraAgentified
  └─ .dataset(name) → MastraDatasetRef
       └─ .register({ tools }) → MastraInstance
            ├─ .discoverTool     — Mastra createTool
            ├─ .prepareStep      — PrepareStepFn
            ├─ .session(id)      → MastraSession
            │    ├─ .discoverTool — Mastra createTool
            │    ├─ .prepareStep
            │    ├─ .context / .conversation (SDK passthrough)
            │    └─ .getMessages / .updateConversation
            └─ .namespace(id)    → MastraNamespace
                 └─ .session(id) → MastraSession
```

Import SDK classes from `agentified`, Mastra-specific adapters from `@agentified/mastra`.

## API Reference

### `mastra()`

Returns an adapter object for `Agentified.adaptTo()`.

```typescript
import { Agentified } from "agentified";
import { mastra } from "@agentified/mastra";

const ag = new Agentified().adaptTo(mastra());
```

### `MastraInstance`

Wraps SDK `Instance`. `discoverTool` is a Mastra `createTool` result instead of a raw `DiscoverTool`.

### `MastraSession`

Wraps SDK `Session`. `discoverTool` is a Mastra `createTool` result. Delegates `context`, `conversation`, `getMessages`, `updateConversation` to the SDK session.

### `AgentifiedMastra`

Standalone Mastra agent wrapper with prefetch, tool hydration, and AG-UI streaming.

```typescript
import { tool } from "agentified";
import type { ServerTool } from "agentified";
import { AgentifiedMastra } from "@agentified/mastra";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";

const tools: ServerTool[] = [
  tool({ name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }),
];

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  get_weather: async (args) => ({ temp: 22, city: args.city }),
};

const agent = new Agent({
  name: "my-agent",
  instructions: "You are a helpful assistant.",
  model: openai("gpt-4o-mini"),
});

const ag = new AgentifiedMastra({
  agentifiedUrl: "http://localhost:9119",
  tools,
  toolHandlers,
  agent,
});

// Register tools with agentified-core
await ag.register();

// Generate — prefetches relevant tools, hydrates them, calls LLM
const result = await ag.generate({
  messages: [{ role: "user", content: "What's the weather in Rome?" }],
});
// result.text, result.toolCalls, result.turnId, result.hydratedTools

// Generate with session continuity — pass turnId from previous call
const next = await ag.generate({
  messages: [{ role: "user", content: "And in Paris?" }],
  turnId: result.turnId,
});

// Stream AG-UI events via Observable
const observable = await ag.run({
  messages: [{ role: "user", content: "What's the weather in Berlin?" }],
});
```

See [mastra-smoke](../../../examples/mastra-smoke/) for a runnable version.

### `streamSSE(observable, res)`

Pipes an AG-UI Observable into an HTTP SSE response.

```typescript
import { streamSSE } from "@agentified/mastra";
```

### `jsonSchemaToZod(schema)`

Converts a JSON Schema object to a Zod schema. Used internally to hydrate Mastra tools.

```typescript
import { jsonSchemaToZod } from "@agentified/mastra";
```

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [Mastra guide](../../../docs/guides/mastra.md) — Full-stack walkthrough
- [Architecture](../../../docs/architecture.md)
- [TypeScript SDK](../sdk/README.md)
- [Frontend Client](../fe-client/README.md)
- [React Bindings](../react/README.md)
- [mastra-smoke example](../../../examples/mastra-smoke/) — runnable smoke test
- [QuickHR Example](../../../examples/quickhr/) — full Mastra + React app

## License

[MIT](../../../LICENSE.md#mit-license)
