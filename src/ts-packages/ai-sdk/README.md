# @agentified/ai-sdk

Vercel AI SDK adapter for [Agentified](../../../README.md) — wraps SDK classes with AI SDK-typed shells via composition. Tools are exposed as AI SDK `tool()` objects for direct use with `generateText`/`streamText`.

## Install

```bash
npm install @agentified/ai-sdk agentified
```

**Peer dependencies:** `ai >= 4.0.0`, `zod >= 3.0.0`

## Quick Start

```typescript
import { Agentified } from "agentified";
import { aiSdk } from "@agentified/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";

const ag = new Agentified().adaptTo(aiSdk());
await ag.connect("http://localhost:9119");

const instance = await ag.dataset("my-agent").register({
  tools: [
    { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, handler: async (args) => ({ temp: 22 }) },
  ],
});

const session = instance.session("chat-1");

// All tools passed upfront, prepareStep controls activeTools per step
const result = await generateText({
  model: openai("gpt-4o"),
  tools: session.tools,
  prepareStep: session.prepareStep,
  stopWhen: stepCountIs(10),
  prompt: "Use agentified_discover to find tools, then call them.",
});

// Persist final step's messages (prepareStep only flushes previous steps)
await session.flushMessages(result.steps);
```

### With Context Builder

```typescript
const ctx = await session.context
  .tools({ agentified_discover: session.discoverTool })
  .messages({ strategy: "recent", maxTokens: 4000 })
  .recall({ tools: true })
  .assemble();

const result = await generateText({
  model: openai("gpt-4o"),
  tools: ctx.tools,
  prepareStep: ctx.prepareStep,
  stopWhen: stepCountIs(10),
  messages: ctx.messages.map(m => ({ role: m.role as any, content: m.content })),
});

await ctx.flushMessages(result.steps);
```

## Key Differences from Mastra Adapter

| Concern | Mastra (`@agentified/mastra`) | AI SDK (`@agentified/ai-sdk`) |
|---|---|---|
| Tool delivery | `prepareStep` returns `{ tools }` per step | `tools` property upfront; `prepareStep` returns `{ activeTools: string[] }` |
| Tool creation | `createTool()` from `@mastra/core` | `tool()` from `ai` |
| Final step | Handled by Mastra | Call `flushMessages(result.steps)` after `generateText` |
| Streaming | `streamSSE()` export | Use `streamText()` from `ai` directly |

## Adapter Pattern

```
Agentified.adaptTo(aiSdk()) → AiSdkAgentified
  └─ .dataset(name) → AiSdkDatasetRef
       └─ .register({ tools }) → AiSdkInstance
            ├─ .tools            — Record<string, CoreTool> (all tools upfront)
            ├─ .discoverTool     — AI SDK tool()
            ├─ .prepareStep      — returns { activeTools: string[] }
            ├─ .session(id)      → AiSdkSession
            │    ├─ .tools             — includes discover + getMessages + backend
            │    ├─ .discoverTool      — AI SDK tool()
            │    ├─ .getMessagesTool   — AI SDK tool()
            │    ├─ .prepareStep       — returns { activeTools: string[] }
            │    ├─ .flushMessages(steps) — persist final step
            │    ├─ .context           → AiSdkContextBuilder
            │    │    ├─ .tools() / .messages() / .recall() / .limitTokens()
            │    │    └─ .assemble()   → AiSdkAssembledContext
            │    │         ├─ .tools          — explicit + discovered
            │    │         ├─ .prepareStep    — returns { activeTools }
            │    │         └─ .flushMessages  — persist final step
            │    ├─ .conversation (SDK passthrough)
            │    └─ .getMessages / .updateConversation
            └─ .namespace(id)    → AiSdkNamespace
                 └─ .session(id) → AiSdkSession
```

## API Reference

### `aiSdk()`

Returns an adapter object for `Agentified.adaptTo()`.

### `AiSdkInstance`

Wraps SDK `Instance`. Exposes `tools` (all registered tools as AI SDK objects) and `prepareStep` (returns `{ activeTools }`).

### `AiSdkSession`

Wraps SDK `Session`. Exposes `tools`, `prepareStep`, `flushMessages`, and `context` builder. `discoverTool` and `getMessagesTool` are AI SDK `tool()` results.

### `flushMessages(steps)`

Call after `generateText`/`streamText` completes to persist the final step's messages. The SDK's `prepareStep` persists messages from *previous* steps, but the last step has no subsequent `prepareStep` call.

### `jsonSchemaToZod(schema)`

Converts a JSON Schema object to a Zod schema. Used internally to hydrate AI SDK tools.

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [Architecture](../../../docs/server/architecture.md)
- [TypeScript SDK](../sdk/README.md)

## License

[MIT](../../../LICENSE.md#mit-license)
