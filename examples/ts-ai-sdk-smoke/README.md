# ai-sdk-smoke

End-to-end smoke test for the Agentified AI SDK adapter — registers tools, runs LLM generation with tool calling via Vercel AI SDK's `generateText`, and verifies tool discovery.

## Prerequisites

- **Docker** (to run agentified-core)
- **Node.js 18+** and **pnpm**
- **`OPENAI_API_KEY`** — used for both embeddings (agentified-core) and LLM calls (gpt-4o-mini)

> **Note:** Requires AI SDK v6 (`ai@^6.0.0`) and `@ai-sdk/openai@^3.0.0`.

## Run

```bash
# 1. Start agentified-core
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core

# 2. Create .env at repo root (or export OPENAI_API_KEY)
echo "OPENAI_API_KEY=sk-..." > ../../.env

# 3. Run the smoke test
cd examples/ts-ai-sdk-smoke
pnpm install
pnpm tsx index.ts
```

## Checkpoints

| # | What it tests |
|---|---------------|
| 1 | `register()` — tools registered with agentified-core |
| 2 | `generateText()` — plain text response (no tools) |
| 3 | `generateText()` — LLM triggers `get_weather` tool call via `prepareStep` |
| 4 | `generateText()` — context chain discovers and calls `search_docs` |

## Next steps

- [Getting Started](../../docs/typescript/getting-started.md) — full walkthrough
- [ts-sdk-smoke](../ts-sdk-smoke/) — SDK-only version (no LLM)
- [AI SDK guide](../../docs/typescript/integrations/ai-sdk.md) — integration guide
- [AI SDK adapter README](../../src/ts-packages/ai-sdk/README.md) — API reference
