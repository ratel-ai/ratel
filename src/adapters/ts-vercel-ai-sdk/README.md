# `@ratel-ai/vercel-ai-sdk`

The [Vercel AI SDK](https://sdk.vercel.ai) (`ai@^5 || ^6 || ^7`) adapter for [Ratel](https://github.com/ratel-ai/ratel). `ratel(config).adaptTo(aiSdk())` layers a framework-shaped view over the framework-neutral core (ADR-0013), so an AI SDK agent registers its own `tool()`s, hands the model Ratel's capability funnel, and gets per-turn recall — all in the SDK's native `Tool` and `ModelMessage` shapes, with no glue in app code.

Ratel keeps the model's tool list small and stable: instead of advertising every tool, it exposes three capability tools (`search_capabilities` / `invoke_tool` / `get_skill_content`) and injects a ranked, per-turn `search_capabilities` result for the current user message. The core owns all state and every guard (reserved ids, top-K clamp, first-registration-wins, recall-id counter); the adapter is just three codecs plus two recall idioms.

## Usage

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { aiSdk } from "@ratel-ai/vercel-ai-sdk";
import { ratel } from "@ratel-ai/sdk";
import { type ModelMessage, streamText, tool } from "ai";
import { z } from "zod";

const r = ratel({ method: "hybrid", recallTopK: 5 }).adaptTo(aiSdk());

// Register the app's AI SDK tools into the shared catalog (any time, also after
// modelTools()). Tools without an `execute` (provider-executed) pass through eagerly.
r.tools.register({
  weather: tool({
    description: "Get the weather in a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => ({ location, tempF: 72 }),
  }),
});

// Take the model-facing set ONCE per agent and reuse it: the three capability
// tools never change across turns, so the prompt cache survives.
const tools = r.modelTools();

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
// (`responseMessages` is ai@7's accessor; on ai@5/ai@6 push `(await result.response).messages`.)
messages.push(...(await result.responseMessages));
```

`prepareStep` is the alternative injection point — drop it straight into `generateText` / `streamText` / `ToolLoopAgent` and skip the manual `appendRecall` call:

```ts
const result = streamText({
  model: anthropic("claude-haiku-4-5"),
  tools: r.modelTools(),
  messages, // your own history, untouched
  prepareStep: r.prepareStep, // injects the recall pair on step 0
});
```

Standalone (framework-free) use of the same core is also fine — `r` is `ratel(config)` before `.adaptTo`, exposing native `ExecutableTool`s. See [`@ratel-ai/sdk`](../../sdk/ts/README.md).

## Two ways to recall: `appendRecall` vs `prepareStep`

Both inject the same synthetic `search_capabilities` call/result pair; they differ in **persistence**, which is what drives prompt-cache behaviour across turns.

- **`appendRecall(messages)`** mutates your message array in place, appends the pair at the **suffix**, and returns the same array. You persist it into your durable history (right alongside `result.responseMessages`). Because a suffix append only *extends* the transcript prefix your host replays next turn, it grows the cached prefix instead of busting it, and each turn's recall stacks after the last. Cost: your stored history carries one recall pair per turn, and persisting it is your responsibility.

- **`prepareStep`** injects the pair via a step-0 `messages` override on a single `generateText` / `streamText` call, as a fresh array that never touches your stored history. Within a multi-step tool loop the pair rides in **every step's prompt** of that call: `ai@7` carries the step-0 override forward on its own, while `ai@5`/`ai@6` rebuild the prompt per step, so the adapter reinserts the cached pair at its original boundary (per-run state; never a duplicate, never a second recall). Either way it is discarded once the call returns and never enters your durable transcript. Nothing to persist; your history stays clean. Cost: the pair is rebuilt on each call and re-sent on each step of a multi-step call, and — living outside the history your host replays — it accrues no cross-turn cache credit the way a persisted append does.

Rule of thumb: for a long-lived multi-turn agent that already persists `responseMessages`, `appendRecall` keeps recalls inside the cached prefix across turns. For a one-shot or stateless call — or when you'd rather not store recall pairs in your history — `prepareStep` is the lighter drop-in. Both are shipped so a host can measure `cachedInputTokens` on its own traffic and pick.

## Limitations

- **Persist the response messages** (`await result.responseMessages` on `ai@7`; `(await result.response).messages` on `ai@5`/`ai@6`, which have no `responseMessages`). Recall fires only when the last message is the user's turn. If you drop the accumulated response messages between turns, turn *N+1* loses turn *N*'s tool calls and results — standard AI SDK message hygiene, load-bearing here.
- **Fabricated execution options for catalog-invoked tools.** When the model runs one of your tools through `invoke_tool`, the catalog calls its `execute(input, options)` with a *fabricated* options object (`toolCallId: "ratel_<id>"`, `messages: []`, and both context spellings — `experimental_context` for `ai@6`/late `ai@5`, `context` for `ai@7` — as `undefined`). A tool that reads `options.messages` or its version's context field sees these fakes, not live values; tools that read only their input args are unaffected.
- **`appendRecall` is async.** Core recall is asynchronous (unlike the sync prototype this was extracted from) — `await` it.
- **Dynamic tool descriptions resolve once, at ingest.** Retrieval ranks on the description at registration time, so a function `description` is called once with a null context (`{ context: undefined }`) when the tool is registered. A description that depends on live tool context won't reflect it in ranking.

## Compatibility

Peer range: **`ai@^5.0.0 || ^6.0.0 || ^7.0.0`** — one shared code path, no per-major builds. The differences the adapter absorbs: provider-defined tools use `type: "provider-defined"` in `ai@5` vs `type: "provider"` in `ai@6`/`ai@7`; tool executors get `experimental_context` in `ai@6` and later `ai@5` releases (the `5.0.0` floor predates any context field) vs `context` in `ai@7` — the adapter always fabricates both spellings; `prepareStep`'s step-0 override is carried forward by `ai@7` but rebuilt per step by `ai@5`/`ai@6` (the adapter reinserts). One difference stays host-side: the persisted-history accessor is `result.responseMessages` on `ai@7` vs `(await result.response).messages` on `ai@5`/`ai@6`.

Each supported major is verified in CI at two exact releases — its floor and its latest verified release — as `ai@5.0.0`, `5.0.217`, `6.0.0`, `6.0.232`, `7.0.0`, `7.0.33` (the `ai-sdk compat` matrix in `.github/workflows/ts.yml`): every row builds, typechecks, tests, packs, and typechecks a packed-tarball consumer against that exact `ai`. Releases between floor and latest are covered by the range, not row-verified.

- **`ai@4` is excluded.** The v5 release reshaped the tool and message surface the adapter speaks (`inputSchema`/`ModelMessage`-era shapes); `ai@4` predates it and would need a different adapter, not a wider range.
- **Breaking-change policy:** narrowing the supported-majors peer range (dropping a major) is a breaking change of this adapter and ships as a major (post-1.0) with a changelog callout — never a patch or minor. Widening the range to a new `ai` major is additive.

## Package shape

- Package name: `@ratel-ai/vercel-ai-sdk`
- Pure TypeScript, **zero runtime dependencies** — the adapter is glue. `ai@^5.0.0 || ^6.0.0 || ^7.0.0` and `@ratel-ai/sdk` are peers the host already installs.
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md)); member of the pnpm workspace; `publishConfig` provenance on.

## Build & test

From the repo root (the SDK is built first by `pnpm -r build`, which the tests import):

```bash
pnpm --filter @ratel-ai/vercel-ai-sdk build
pnpm --filter @ratel-ai/vercel-ai-sdk typecheck
pnpm --filter @ratel-ai/vercel-ai-sdk lint
pnpm --filter @ratel-ai/vercel-ai-sdk test
```

The suite covers the three codecs, both recall helpers (including id economy on the no-op paths), mock-model integration tests that drive real two-step `generateText` / `streamText` loops, a compile-only type-test locking the `ai` surface, and the `@ratel-ai/sdk/testkit` conformance battery (21 cases, 0 skipped). The dev `ai` is pinned to the exact release the adapter was last live-verified on; the CI matrix re-pins it per row (see [Compatibility](#compatibility)).
