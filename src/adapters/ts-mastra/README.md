# `@ratel-ai/mastra`

The [Mastra](https://mastra.ai) (`@mastra/core`) adapter for [Ratel](https://github.com/ratel-ai/ratel). `ratel(config).adaptTo(mastra())` layers a framework-shaped view over the framework-neutral core (ADR-0013), so a Mastra agent registers its own `createTool()`s, hands the model Ratel's capability funnel, and gets per-turn recall — all in Mastra's native `Tool` and `MastraDBMessage` shapes, with no glue in app code.

Ratel keeps the model's tool list small and stable: instead of advertising every tool, it exposes three capability tools (`search_capabilities` / `invoke_tool` / `get_skill_content`) and injects a ranked, per-turn `search_capabilities` result for the current user message. The core owns all state and every guard (reserved ids, top-K clamp, first-registration-wins, recall-id counter); the adapter is just three codecs plus one recall idiom.

## Usage

```ts
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { mastra } from "@ratel-ai/mastra";
import { ratel } from "@ratel-ai/sdk";
import { z } from "zod";

const r = ratel({ method: "hybrid", recallTopK: 5 }).adaptTo(mastra());

// Register the app's Mastra tools into the shared catalog (any time, also after
// modelTools()). Tools without an `execute` (client/provider-executed) pass through eagerly.
r.tools.register({
  weather: createTool({
    id: "weather",
    description: "Get the weather in a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => ({ location, tempF: 72 }),
  }),
});

const agent = new Agent({
  name: "assistant",
  instructions: "Help the user with their tasks.",
  model: "openai/gpt-4o-mini",
  // The three capability tools in Mastra shape. Take the set ONCE per agent and
  // reuse it: it never changes across turns, so the prompt cache survives.
  tools: r.modelTools(),
  // Rank the catalog for each user turn and inject the synthetic search_capabilities
  // call+result before the model runs (recall mode).
  inputProcessors: [r.recallProcessor()],
});

const result = await agent.generate("what's the weather in Paris?");
console.log(result.text);
```

Standalone (framework-free) use of the same core is also fine — `r` is `ratel(config)` before `.adaptTo`, exposing native `ExecutableTool`s. See [`@ratel-ai/sdk`](../../sdk/ts/README.md).

## The `recallProcessor()` idiom

`r.recallProcessor()` returns a fresh Mastra [`Processor`](https://mastra.ai/en/docs/agents/input-processors) each call (so several agents each get their own). It implements `processInput`, which Mastra runs **once at the start of every generation** — i.e. once per user turn. On each turn it:

1. reads the last message's text iff that message is the user's turn (multi-part text joins with newlines);
2. ranks the catalog with the core's `recall(query)`;
3. if there are hits, appends the synthetic `search_capabilities` call+result to the messages the model sees.

It is a no-op — spending no recall-id — when the last message is not a user turn, the user text is empty, or nothing matched. Because `processInput` runs once per generation (not per step), the pair is injected once and is **not** re-injected during the agent's tool-call loop.

## Limitations

- **Single-message recall encoding.** A `MastraDBMessage` has no `tool` role: a completed call+result is one assistant message with `content.format: 2` and a single resolved `tool-invocation` part. The recall pair is therefore encoded as **one** assistant message (Mastra renders it to the model as an assistant tool-call followed by a tool result).
- **Fabricated execution context for catalog-invoked tools.** When the model runs one of your tools through `invoke_tool`, the catalog calls its `execute(args, context)` with a *minimal fabricated* context (`{ observe }` no-op; `mastra` / `agent` / `workflow` / `abortSignal` absent, `requestContext` a fresh empty one). A tool that reads those sees the fakes; tools that read only their input args are unaffected. Mastra re-validates the args against the tool's schema on this call; invalid args (or a required `requestContextSchema` the fabricated context can't satisfy) surface as a thrown error, which the capability funnel reports as a failed call.
- **Any Mastra tool schema works.** `ingest` reads Mastra's *already-normalized* input schema, so tools built with zod 3, zod 4, or a raw JSON Schema all catalog correctly — the adapter never re-converts schemas itself. (`zod` is a peer only because the exposed capability tools carry hand-written zod schemas.)
- **Persist the conversation across turns.** Recall fires only when the last message is the user's turn. Standard Mastra memory hygiene applies; if you rebuild the message history per call, keep the user turn last so recall can find it.

## Package shape

- Package name: `@ratel-ai/mastra`
- Pure TypeScript, **zero runtime dependencies** — the adapter is glue. `@mastra/core@>=1.11.0 <2`, `zod@^3.25.0 || ^4.0.0` (matching Mastra's own zod peer), and `@ratel-ai/sdk` are peers the host already installs.
- Requires Node.js 22.13 or newer, matching Mastra's own requirement.
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md)); member of the pnpm workspace; `publishConfig` provenance on.

## Mastra compatibility

The supported range is `@mastra/core@>=1.11.0 <2`. Version 1.11 is the floor because it is the first 1.x release where `createTool()` normalizes zod and raw JSON schemas to the Standard Schema surface that `ingest` reads.

There is no runtime version detection. The adapter stays on the common public tool, message, and processor shapes and owns two tiny compatibility details locally: the no-op observer context and the structural validation-error check. This avoids imports that Mastra only exported later (`isValidationError` in 1.18 and `noopObserve` in 1.37) while preserving their behavior. CI runs the adapter build, suite, and type tests against exact 1.11.0, 1.31.0, and 1.51.0; the worked Mastra example also drives a real 1.51 Agent loop.

## Build & test

From the repo root (the SDK is built first by `pnpm -r build`, which the tests import):

```bash
pnpm --filter @ratel-ai/mastra build
pnpm --filter @ratel-ai/mastra typecheck
pnpm --filter @ratel-ai/mastra lint
pnpm --filter @ratel-ai/mastra test
```

The suite covers the three codecs, the recall processor (including id economy on the no-op paths), a mock-model integration test that drives the real Mastra `Agent` loop, a compile-only type-test locking the supported `@mastra/core` surface, and the `@ratel-ai/sdk/testkit` conformance battery (22 cases, 0 skipped). CI repeats it against the minimum Mastra release.
