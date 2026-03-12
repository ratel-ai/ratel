# @agentified/mastra

Mastra adapter layer for [Agentified](../../../README.md) — wraps SDK classes with Mastra-typed shells via composition, plus AG-UI streaming. See the [Mastra guide](../../../docs/typescript/integrations/mastra.md) for a full-stack walkthrough.

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

const instance = await ag.dataset("my-agent").register({
  tools: [
    { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, handler: async (args) => ({ temp: 22 }) },
  ],
});

const session = instance.session("chat-1");
const agent = new Agent({
  name: "my-agent",
  model: openai("gpt-4o-mini"),
  instructions: "Use agentified_discover to find tools, then call them.",
});
const result = await agent.generate(messages, {
  prepareStep: session.prepareStep({ tools: { agentified_discover: session.discoverTool } }),
  maxSteps: 10,
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
            ├─ .prepareStep(opts?) — returns step function that injects tools
            ├─ .session(id)      → MastraSession
            │    ├─ .discoverTool — Mastra createTool
            │    ├─ .prepareStep(opts?)
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
- [Mastra guide](../../../docs/typescript/integrations/mastra.md) — Full-stack walkthrough
- [Architecture](../../../docs/server/architecture.md)
- [TypeScript SDK](../sdk/README.md)
- [Frontend Client](../fe-client/README.md)
- [React Bindings](../react/README.md)
- [mastra-smoke example](../../../examples/mastra-smoke/) — runnable smoke test
- [QuickHR Example](../../../examples/quickhr/) — full Mastra + React app

## License

[MIT](../../../LICENSE.md#mit-license)
