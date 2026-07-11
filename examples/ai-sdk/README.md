# `examples/ai-sdk` — Ratel + Vercel AI SDK

Demonstrates the Ratel SDK wired into the [Vercel AI SDK](https://ai-sdk.dev/). Tools are registered in a `ToolCatalog`; each run exposes the prompt's top-K matches directly and keeps `search_capabilities` plus `invoke_tool` available for the rest of the catalog. See [Capability tools](https://docs.ratel.sh/docs/capability-tools) and [Framework integrations](https://docs.ratel.sh/docs/framework-integrations) for the protocol and reusable wiring pattern.

The agent loop is AI SDK v6's [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) with `stopWhen: stepCountIs(N)`, so it can chain tool calls and a final answer inside one `.generate()` call.

## Setup

```bash
export OPENAI_API_KEY=sk-...
pnpm install
pnpm -F @ratel-ai/example-ai-sdk start
# or with a custom prompt:
pnpm -F @ratel-ai/example-ai-sdk start "send an email to alice@example.com saying ship it"
```

Without `OPENAI_API_KEY` the script runs in diagnostic mode — prints the initial Ratel filter output and exits before any model call.

Override the model with `AI_MODEL=gpt-4o`. To swap providers, replace the import in `src/index.ts` (e.g. `@ai-sdk/anthropic`).

## Layout

```
src/tools.ts        catalog + helpers — ToolCatalog, AI SDK tool wrapping, capability tools
src/agent.ts        runAgent — assembles the static tool set, runs ToolLoopAgent.generate
src/index.ts        entry — parse argv, build model + catalog, run, print
test/agent.test.ts  model-free test of direct and capability-tool paths
```

Splitting `tools.ts` and `agent.ts` keeps the catalog declarative and the loop readable; nothing about the wiring is OpenAI-specific (`runAgent` accepts any `LanguageModel`).

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/sdk` — keeping them out of the published artifact keeps the public API surface narrow and dependency-free. The example pulls `ai` and `@ai-sdk/openai` only here.
