# sdk-smoke

Minimal smoke test for the Agentified TypeScript SDK — registers tools, persists conversation, discovers tools, and verifies session continuity.

## Prerequisites

- **Docker** (to run agentified-core)
- **Node.js 18+** and **pnpm**
- **`OPENAI_API_KEY`** — for embeddings (tool discovery step is skipped if missing)

## Run

```bash
# 1. Start agentified-core with SQLite storage
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... -e AGENTIFIED_STORAGE=sqlite agentified/agentified-core

# 2. Run the smoke test
cd examples/sdk-smoke
pnpm install
pnpm tsx index.ts
```

## Expected output

```
[1] Connected to http://localhost:9119
[2] Registered tools
[3] Session: smoke-<timestamp>
[4] updateConversation: 3 messages persisted
[5] conversation.messages: 3 messages
[6] context.assemble: 3/3 msgs, strategy=recent
[7] discoverTool: 2 tools found
[8] getMessages: 3 messages
[9] after append: 4 messages
[10] updateConversation dedup: 4 messages (should still be 4)

✓ All checks passed!
```

## Next steps

- [Getting Started](../../docs/typescript/getting-started.md) — full walkthrough
- [mastra-smoke](../mastra-smoke/) — same idea with an LLM agent
- [SDK README](../../src/ts-packages/sdk/README.md) — full API reference
