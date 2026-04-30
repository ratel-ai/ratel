# `examples/ai-sdk` — Ratel + Vercel AI SDK + dynamic tool gateway

Demonstrates the v0.1.1 Ratel SDK wired into the [Vercel AI SDK](https://ai-sdk.dev/) with two layers of context engineering:

1. **Pre-filter** ([ADR 0003](../../docs/adr/0003-tool-selection-replace-vs-suggest.md) `replace` mode) — at boot, the catalog is registered in a `ToolRegistry`; before the model call, BM25 narrows it to the top-K most relevant tools for the user's prompt. Those tools land directly in the AI SDK tool list with full schemas.
2. **Dynamic gateway** — two always-present tools, `search_tools` and `invoke_tool`, give the agent reach into the rest of the catalog when the top-K isn't enough. `search_tools` returns matching `{toolId, description, inputSchema}` triples; `invoke_tool` then executes any of those by id.

The agent loop is AI SDK v6's [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) with `stopWhen: stepCountIs(N)`. The agent multi-steps internally — chaining `search_tools` → `invoke_tool` → final answer inside one `.generate()` call.

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
src/tools.ts    catalog + helpers — registry, AI-SDK tool wrapping, search_tools, invoke_tool
src/agent.ts    runAgent — assembles the static tool set, runs ToolLoopAgent.generate
src/index.ts    entry — parse argv, build model + registry, run, print
```

Splitting `tools.ts` and `agent.ts` keeps the catalog declarative and the loop readable; nothing about the wiring is OpenAI-specific (`runAgent` accepts any `LanguageModel`).

## How the gateway works

The agent's tool list at the start of the run is:

- The **top-K** Ratel hits for the initial prompt — direct call, full schema visibility
- **`search_tools(query, topK)`** — returns `[{toolId, score, description, inputSchema}, ...]`
- **`invoke_tool(toolId, args)`** — runs `catalog[toolId].execute(args)`; returns `{ error: "..." }` if the id is unknown or the call throws

When the top-K covers the request, the model calls one directly and answers. When it doesn't, the model calls `search_tools` to discover candidates, then `invoke_tool` with the chosen id and args. `ToolLoopAgent` handles the entire chain — auto-executing tools, threading their results back to the model, and stopping when the model emits final text or `stepCountIs(N)` is reached.

Trade-off: tools called via `invoke_tool` aren't schema-validated by AI SDK at the LLM boundary (only at the catalog's own `execute`). The model has to read the inputSchema from `search_tools` and serialize args correctly. Direct top-K calls get the strict-schema treatment for free.

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/sdk` — keeping them out of the published artifact keeps the public API surface narrow and dependency-free. The example pulls `ai` and `@ai-sdk/openai` only here.
