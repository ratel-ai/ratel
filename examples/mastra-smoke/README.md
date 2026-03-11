# mastra-smoke

End-to-end smoke test for the Agentified Mastra adapter — registers tools, runs LLM generation with tool calling, streams AG-UI events, and verifies session continuity.

## Prerequisites

- **Docker** (to run agentified-core)
- **Node.js 18+** and **pnpm**
- **`OPENAI_API_KEY`** — used for both embeddings (agentified-core) and LLM calls (gpt-4o-mini)

> **Note:** `@ai-sdk/openai` must be `^3.0.0` (AI SDK v4). Mastra 1.11+ rejects v1.x of `@ai-sdk/openai`.

## Run

```bash
# 1. Start agentified-core
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core

# 2. Create .env at repo root (or export OPENAI_API_KEY)
echo "OPENAI_API_KEY=sk-..." > ../../.env

# 3. Run the smoke test
cd examples/mastra-smoke
pnpm install
pnpm tsx index.ts
```

## Checkpoints

| # | What it tests |
|---|---------------|
| 1 | `register()` — tools registered with agentified-core |
| 2 | `generate()` — plain text response (no tools) |
| 3 | `generate()` — LLM triggers `get_weather` tool call |
| 4 | `generate({ debug })` — debug log entries returned |
| 5 | `run()` — AG-UI Observable events (RUN_STARTED, CUSTOM) |
| 6 | `generate({ turnId })` — session continuity across turns |
| 7 | `generate()` — LLM discovers and calls `search_docs` |

## Next steps

- [Getting Started](../../docs/getting-started.md) — full walkthrough
- [sdk-smoke](../sdk-smoke/) — SDK-only version (no LLM)
- [Mastra guide](../../docs/guides/mastra.md) — full-stack walkthrough
- [Mastra adapter README](../../src/ts-packages/mastra/README.md) — API reference
