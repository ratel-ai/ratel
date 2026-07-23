# `examples/ai-sdk` — Ratel + Vercel AI SDK

Demonstrates Ratel wired into the [Vercel AI SDK](https://ai-sdk.dev/) through [`@ratel-ai/vercel-ai-sdk`](../../src/adapters/ts-vercel-ai-sdk/README.md): AI SDK-native `tool()` definitions go straight into the shared catalog via `ratel().adaptTo(aiSdk())`, the model sees only the three capability tools (`view.modelTools()`), and `view.prepareStep` injects the per-turn recall pair — no hand-written conversion glue anywhere. See [Capability tools](https://docs.ratel.sh/docs/capability-tools) and [Framework integrations](https://docs.ratel.sh/docs/framework-integrations) for the protocol.

The agent loop is AI SDK v6's [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) with `stopWhen: stepCountIs(N)`, so it can chain tool calls and a final answer inside one `.generate()` call.

## Setup

```bash
export OPENAI_API_KEY=sk-...
pnpm install
pnpm -F @ratel-ai/example-ai-sdk start
# or with a custom prompt:
pnpm -F @ratel-ai/example-ai-sdk start "send an email to alice@example.com saying ship it"
```

Without `OPENAI_API_KEY` the script runs in diagnostic mode — prints the recall hits Ratel would inject and exits before any model call.

Override the model with `AI_MODEL=gpt-4o`. To swap providers, replace the import in `src/index.ts` (e.g. `@ai-sdk/anthropic`).

## Layout

```
src/tools.ts        AI SDK-native tool() definitions — the demo catalog, no Ratel shapes
src/agent.ts        createRatelView (core + aiSdk() view) and runAgent (ToolLoopAgent loop)
src/index.ts        entry — parse argv, build model + view, run, print
test/agent.test.ts  model-free test: scripted mock drives search -> invoke -> answer
```

Splitting `tools.ts` and `agent.ts` keeps the catalog declarative and the loop readable; nothing about the wiring is OpenAI-specific (`runAgent` accepts any `LanguageModel`).

The example pins `ai@^6` on purpose: the adapter's own package verifies v5–v7 (exact floor and latest rows in CI), while this app proves the wiring on the middle major. Its `tsconfig.json` maps `ai` to the example's own install so the workspace-linked adapter's types resolve the same single `ai` a published install would.

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/sdk` — keeping them out of the published artifact keeps the public API surface narrow and dependency-free. The example pulls `ai` and `@ai-sdk/openai` only here.
