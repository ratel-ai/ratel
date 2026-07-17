# `@ratel-ai/ai-sdk-adapter`

The [Vercel AI SDK](https://sdk.vercel.ai) (`ai@7`) adapter for [Ratel](https://github.com/ratel-ai/ratel). `ratel(config).adaptTo(aiSdk())` layers a framework-shaped view over the framework-neutral core (ADR-0013), so an AI SDK agent registers its own `tool()`s, hands the model Ratel's capability funnel, and gets per-turn recall — all in the SDK's native `Tool` and `ModelMessage` shapes, with no glue in app code.

Ratel keeps the model's tool list small and stable: instead of advertising every tool, it exposes three capability tools (`search_capabilities` / `invoke_tool` / `get_skill_content`) and injects a ranked, per-turn `search_capabilities` result for the current user message. The core owns all state and every guard (reserved ids, top-K clamp, first-registration-wins, recall-id counter); the adapter is just three codecs plus two recall idioms.

## Usage

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { aiSdk } from "@ratel-ai/ai-sdk-adapter";
import { ratel } from "@ratel-ai/sdk";
import { type ModelMessage, streamText, tool } from "ai";
import { z } from "zod";

const r = ratel({ method: "hybrid", recallTopK: 5 }).adaptTo(aiSdk());

// Register the app's AI SDK tools into the shared catalog (any time, also after
// expose()). Tools without an `execute` (provider-executed) pass through eagerly.
r.tools.register({
  weather: tool({
    description: "Get the weather in a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => ({ location, tempF: 72 }),
  }),
});

// Take the model-facing set ONCE per agent and reuse it: the three capability
// tools never change across turns, so the prompt cache survives.
const tools = r.expose();

const messages: ModelMessage[] = [{ role: "user", content: "what's the weather in Paris?" }];

const result = streamText({
  model: anthropic("claude-haiku-4-5"),
  tools,
  // Rank the catalog for this turn and splice in the synthetic search_capabilities
  // pair (recall mode).
  messages: await r.appendRecall(messages),
});
for await (const delta of result.textStream) process.stdout.write(delta);

// Persist the real tool-loop traffic so next turn sees this turn's calls/results.
messages.push(...(await result.responseMessages));
```

`prepareStep` is the alternative injection point — drop it straight into `generateText` / `streamText` / `ToolLoopAgent` and skip the manual `appendRecall` call:

```ts
const result = streamText({
  model: anthropic("claude-haiku-4-5"),
  tools: r.expose(),
  messages, // your own history, untouched
  prepareStep: r.prepareStep, // injects the recall pair on step 0
});
```

Standalone (framework-free) use of the same core is also fine — `r` is `ratel(config)` before `.adaptTo`, exposing native `ExecutableTool`s. See [`@ratel-ai/sdk`](../../sdk/ts/README.md).

## Two ways to recall: `appendRecall` vs `prepareStep`

Both inject the same synthetic `search_capabilities` call/result pair; they differ in **persistence**, which is what drives prompt-cache behaviour across turns.

- **`appendRecall(messages)`** mutates your message array in place, appends the pair at the **suffix**, and returns the same array. You persist it into your durable history (right alongside `result.responseMessages`). Because a suffix append only *extends* the transcript prefix your host replays next turn, it grows the cached prefix instead of busting it, and each turn's recall stacks after the last. Cost: your stored history carries one recall pair per turn, and persisting it is your responsibility.

- **`prepareStep`** injects the pair only into the **first step's prompt** of a single `generateText` / `streamText` call, as a fresh array override that never touches your stored history. Nothing to persist; your transcript stays clean. Cost: the pair is rebuilt each call and, since it lives outside the history your host replays, it does not accumulate cross-turn cache credit the way a persisted append does.

Rule of thumb: for a long-lived multi-turn agent that already persists `responseMessages`, `appendRecall` keeps recalls inside the cached prefix. For a one-shot or stateless call — or when you'd rather not store recall pairs in your history — `prepareStep` is the lighter drop-in. Both are shipped so a host can measure `cachedInputTokens` on its own traffic and pick.

## Limitations

- **Persist `result.responseMessages`.** Recall fires only when the last message is the user's turn. If you drop the accumulated response messages between turns, turn *N+1* loses turn *N*'s tool calls and results — standard AI SDK message hygiene, load-bearing here.
- **Fabricated execution options for catalog-invoked tools.** When the model runs one of your tools through `invoke_tool`, the catalog calls its `execute(input, options)` with a *fabricated* options object (`toolCallId: "ratel_<id>"`, `messages: []`, `context: undefined`). A tool that reads `options.messages` or `options.context` sees these fakes, not live values; tools that read only their input args are unaffected. (`ai@7` requires a `context` field, so it is always present, as `undefined`.)
- **`appendRecall` is async.** Core recall is asynchronous (unlike the sync prototype this was extracted from) — `await` it.
- **Dynamic tool descriptions resolve once, at ingest.** Retrieval ranks on the description at registration time, so a function `description` is called once with a null context (`{ context: undefined }`) when the tool is registered. A description that depends on live tool context won't reflect it in ranking.

## Package shape

- Package name: `@ratel-ai/ai-sdk-adapter`
- Pure TypeScript, **zero runtime dependencies** — the adapter is glue. `ai@^7.0.0` and `@ratel-ai/sdk` are peers the host already installs.
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md)); member of the pnpm workspace; `publishConfig` provenance on.

## Build & test

From the repo root (the SDK is built first by `pnpm -r build`, which the tests import):

```bash
pnpm --filter @ratel-ai/ai-sdk-adapter build
pnpm --filter @ratel-ai/ai-sdk-adapter typecheck
pnpm --filter @ratel-ai/ai-sdk-adapter lint
pnpm --filter @ratel-ai/ai-sdk-adapter test
```

The suite covers the three codecs, both recall helpers (including id economy on the no-op paths), a `MockLanguageModelV3` integration test that drives the real `ai@7` `generateText` loop, a compile-only type-test locking the `ai` surface, and the `@ratel-ai/sdk/testkit` conformance battery (21 cases, 0 skipped).
