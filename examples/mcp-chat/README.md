# `examples/mcp-chat` — interactive chat against an MCP-backed agent

Spawns an MCP server over stdio, registers its tools into a Ratel `ToolCatalog`, and drops you into a terminal REPL. Each turn:

1. Ratel BM25-ranks the catalog against your message and loads the top-K directly into the agent's tool list.
2. Two always-on capability tools (`search_capabilities`, `invoke_tool`) let the agent reach the rest of the catalog when the top-K isn't enough.
3. Every tool call (and its truncated result) is printed inline so you can see what the agent is doing.

The agent loop is Vercel AI SDK v6's [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent); message history is threaded across turns.

## Setup

```bash
export OPENAI_API_KEY=sk-...
pnpm install
pnpm -F @ratel-ai/example-mcp-chat start
```

Override the model with `AI_MODEL=gpt-4o` (or swap the provider import in `src/index.ts`). The default upstream MCP server is `npx -y @modelcontextprotocol/server-everything`; override with:

```bash
MCP_COMMAND=/path/to/mcp-server MCP_ARGS="--flag value" MCP_SERVER_NAME=fs \
  pnpm -F @ratel-ai/example-mcp-chat start
```

`MCP_ARGS` is space-split. For Streamable HTTP / SSE transports, edit `src/index.ts` and swap `StdioClientTransport` for the relevant transport from `@modelcontextprotocol/sdk` — `registerMcpServer` accepts any MCP `Transport`.

Type `exit` (or send Ctrl-D) to quit; the MCP subprocess is shut down on exit.

## What the output looks like

```
spawning MCP server: npx -y @modelcontextprotocol/server-everything
namespace: "ev"
model: gpt-5-mini

[ratel] 13 MCP tools registered:
  - ev__echo
  - ev__get-sum
  ...

you> what's 7 + 35?

[ratel] loaded tools for this turn: ev__get-sum, ev__echo, ev__trigger-long-running-operation, search_capabilities, invoke_tool
[step 1] → ev__get-sum({"a":7,"b":35})
[step 1] ← ev__get-sum: {"content":[{"type":"text","text":"The sum of 7 and 35 is 42."}]}

assistant> 7 + 35 = 42.
```

The "loaded tools" line is the per-turn proof that Ratel narrowed the agent's tool list. With 13 MCP tools registered and `initialTopK=3`, the agent only sees 3 + 2 capability tools by default — the rest stay reachable via `search_capabilities` / `invoke_tool` without occupying context.

## Layout

```
src/index.ts   entry — spawn MCP, register tools, run REPL
src/chat.ts    Chat class — per-turn tool-set rebuild, ToolLoopAgent.generate, history threading
src/tools.ts   toAISDKTool — adapt Ratel's ExecutableTool to AI SDK's tool() shape
```

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/sdk`. The LLM provider (`@ai-sdk/openai`) and AI SDK runtime (`ai`) live here so apps that consume `@ratel-ai/sdk` for retrieval-only paths don't pay for them.
