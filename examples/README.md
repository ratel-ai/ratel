# `examples/`

Runnable demos of Ratel wired into real agent frameworks and protocol surfaces. Each entry is a private workspace package (not published).

## Layout

```
ai-sdk/            Ratel + Vercel AI SDK — top-K tool filtering before generateText
mcp-chat/          Interactive REPL against an MCP-backed agent (Vercel AI SDK + OpenAI)
pydantic-ai/       Ratel + Pydantic AI (Python) — top-K filtering + gateway before the agent run
end-user-skills/   Ratel + Cloud — one end-user's usage -> a per-user skill suggestion, reviewed via the SDK (CLI)
end-user-skills-app/  The same loop as a Next.js app: AI SDK chat agent with the live skill catalog + suggestion review UI
```

The MCP-server demo (`mcp-server/` — Claude Code session driven by Ratel as the only MCP) now lives next to the `@ratel-ai/mcp-server` package in [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp).

## Conventions

- Private packages (`"private": true`).
- Pull external integrations (e.g. `ai`, `@ai-sdk/openai`) here, not in `@ratel-ai/sdk`.
- A `start` script that runs the demo end-to-end.
- Each example's README documents the exact env vars (model API keys) and the wiring pattern it illustrates.
