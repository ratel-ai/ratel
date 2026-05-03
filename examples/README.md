# `examples/`

Runnable demos of Ratel wired into real agent frameworks and protocol surfaces. Each entry is a private workspace package (not published).

## Layout

```
ai-sdk/      Ratel + Vercel AI SDK — top-K tool filtering before generateText
mcp-chat/    Interactive REPL against an MCP-backed agent (Vercel AI SDK + OpenAI)
mcp-server/  Claude Code session driven by Ratel as the only MCP, fronting N upstream MCPs
```

## Conventions

- Private packages (`"private": true`).
- Pull external integrations (e.g. `ai`, `@ai-sdk/openai`) here, not in `@ratel-ai/sdk`.
- A `start` script that runs the demo end-to-end.
- Each example's README documents the exact env vars (model API keys) and the wiring pattern it illustrates.
