# `examples/mastra` — Ratel + Mastra

Demonstrates the Ratel SDK wired into [Mastra](https://mastra.ai) through [`@ratel-ai/mastra`](../../src/adapters/ts-mastra/README.md). App tools are registered as native Mastra `createTool`s on an adapted view (`ratel(config).adaptTo(mastra())`); the Agent is handed only the three capability tools (`view.modelTools()`), and `view.recallProcessor()` injects a ranked `search_capabilities` result for each user turn. See [Capability tools](https://docs.ratel.sh/docs/capability-tools) and [Framework integrations](https://docs.ratel.sh/docs/framework-integrations) for the protocol and reusable wiring pattern.

## Setup

```bash
export OPENAI_API_KEY=sk-...
pnpm install
pnpm -F @ratel-ai/example-mastra start
# or with a custom prompt:
pnpm -F @ratel-ai/example-mastra start "send an email to alice@example.com saying ship it"
```

Without a model API key the script runs in diagnostic mode — it prints Ratel's initial BM25 ranking for the prompt and exits before any model call.

The model is a [Mastra model-router](https://mastra.ai/en/docs/getting-started/model-providers) id (default `openai/gpt-4o-mini`), so there is no provider SDK dependency — the router resolves the key from the environment. Override with `MASTRA_MODEL=anthropic/claude-haiku-4-5` (and set the matching key).

## Layout

```
src/tools.ts        the app's Mastra createTool tools (stubs)
src/agent.ts        buildView (ratel().adaptTo(mastra()) + register) and runAgent (Agent + modelTools + recallProcessor)
src/index.ts        entry — parse argv, run, print (diagnostic mode without a key)
test/agent.test.ts  model-free test of the capability-tool + recall path (Mastra's mock model)
```

The Agent never sees the six app tools directly — only `search_capabilities` / `invoke_tool` / `get_skill_content`. It discovers a tool by searching, then runs it through `invoke_tool`.

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/mastra` — keeping them out of the published artifact keeps the public API surface narrow. The example pulls `@mastra/core` only here.
