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

// Simple — prepareStep is a property, includes discover by default
const result = await agent.generate(messages, {
  prepareStep: session.prepareStep,
  maxSteps: 10,
});

// With explicit tools via context chain
const ctx = await session.context
  .tools({ agentified_discover: session.discoverTool })
  .assemble();
// ctx.tools → { agentified_discover, ...discoveredTools }
// ctx.prepareStep → returns { tools } for Mastra injection
const result2 = await agent.generate(messages, {
  prepareStep: ctx.prepareStep,
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
            ├─ .prepareStep      — property, returns { tools } for injection
            ├─ .session(id)      → MastraSession
            │    ├─ .discoverTool      — Mastra createTool
            │    ├─ .getMessagesTool  — Mastra createTool (conversation navigation)
            │    ├─ .prepareStep  — property, returns { tools }
            │    ├─ .context      → MastraContextBuilder
            │    │    ├─ .tools(Record<string, MastraTool>) — chainable
            │    │    ├─ .messages() / .recall()
            │    │    └─ .assemble() → MastraAssembledContext
            │    │         ├─ .tools — explicit + discovered
            │    │         └─ .prepareStep — returns { tools }
            │    ├─ .conversation (SDK passthrough)
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

Wraps SDK `Session`. `discoverTool` and `getMessagesTool` are Mastra `createTool` results. Delegates `context`, `conversation`, `getMessages`, `updateConversation` to the SDK session. `prepareStep` includes both `agentified_discover` and `agentified_get_messages` in the returned tools.

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

## Observability

`MastraAgentified` forwards `context:assembled` / `recall` events from the underlying SDK and adds a `step` event that fires once per agent step.

```typescript
const mag = new Agentified().adaptTo(mastra());
await mag.connect("http://localhost:9119");

const instance = await mag.register({ tools: [...] });
const session = instance.session("chat-1");

mag.on("context:assembled", (evt) => metrics.emit("ctx", evt));
session.on("step", (evt) => metrics.emit("step", evt));

const ctx = await session.context.recall().messages({ strategy: "recent" }).assemble();
const result = await agent.generate(messages, {
  prepareStep: ctx.prepareStep,
  onStepFinish: session.onStepFinish, // wires Mastra steps into the "step" event
});
```

### Event names + payloads

| Event | Source | Payload |
| --- | --- | --- |
| `context:assembled` | SDK | `sessionId`, `datasetId`, `strategyUsed`, `totalMessages`, `includedMessages`, `tokenEstimate`, `fallback`, `recalled: { tools }`, `durationMs` |
| `recall` | SDK | `sessionId`, `datasetId`, `config`, `matches`, `durationMs` |
| `step` | Mastra | `sessionId`, `stepIndex`, `toolCalls`, `toolResults`, `usage`, `finishReason`, `durationMs` |

`mag.on(...)`, `instance.on(...)`, `session.on(...)` all return a disposer. Listeners can be sync or async; listener errors are swallowed.

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [Mastra guide](../../../docs/typescript/integrations/mastra.md) — Full-stack walkthrough
- [Architecture](../../../docs/server/architecture.md)
- [TypeScript SDK](../sdk/README.md)
- [Frontend Client](../fe-client/README.md)
- [React Bindings](../react/README.md)
- [ts-mastra-smoke example](../../../examples/ts-mastra-smoke/) — runnable smoke test
- [QuickHR Example](../../../examples/quickhr/) — full Mastra + React app

## License

[MIT](../../../LICENSE.md#mit-license)
