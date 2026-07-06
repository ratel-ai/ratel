# `examples/pydantic-ai` — Ratel + Pydantic AI + dynamic tool gateway

The Python mirror of [`examples/ai-sdk`](../ai-sdk/README.md): the [`ratel-ai`](../../src/sdk/python/README.md) SDK wired into [Pydantic AI](https://ai.pydantic.dev/) with two layers of context engineering:

1. **Pre-filter** ([ADR-0004](../../docs/adr/0004-retrieval-and-tool-selection.md) `replace` mode) — the catalog is registered in a `ToolCatalog`; before the model call, retrieval narrows it to the top-K most relevant tools for the prompt. Those land directly in the agent's tool list with full schemas.
2. **Dynamic gateway** — two always-present tools, `search_capabilities` and `invoke_tool`, give the agent reach into the rest of the catalog when the top-K isn't enough. `search_capabilities` returns a `tools` bucket (hits grouped by upstream server) plus a `skills` bucket — `{tools: {groups: [{server, hits: [{toolId, score, description, inputSchema}]}]}, skills: [...]}` (the skills bucket is empty here — this example registers no skills); `invoke_tool` executes a tool by id.

Tools are built from the catalog's JSON schemas via Pydantic AI's `Tool.from_schema`, so the schema the model sees is the same one Ratel ranks.

## Setup

```bash
export OPENAI_API_KEY=sk-...
uv run main.py
# or with a custom prompt:
uv run main.py "send an email to alice@example.com saying ship it"
```

`uv run` resolves `ratel-ai` from this monorepo (see `[tool.uv.sources]` in `pyproject.toml`) and `pydantic-ai` from PyPI, building the native extension on first run.

Without a model API key the script runs in **diagnostic mode** — prints the initial Ratel BM25 filter output and exits before any model call. Override the model with `RATEL_EXAMPLE_MODEL` (a Pydantic AI model id, e.g. `anthropic:claude-sonnet-4-6` or `openai:gpt-5-mini`); supported key env vars include `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`.

## Layout

```
tools.py    catalog + helpers — six stub tools registered into a ToolCatalog
agent.py    run_agent — assembles the tool set (top-K + gateway), runs the Pydantic AI Agent
main.py     entry — parse argv, diagnostic mode or model run, print
```

Splitting `tools.py` and `agent.py` keeps the catalog declarative and the loop readable; nothing about the wiring is provider-specific (`run_agent` accepts any Pydantic AI model id).

## How the gateway works

The agent's tool list at the start of the run is:

- The **top-K** Ratel hits for the initial prompt — direct call, full schema visibility
- **`search_capabilities(query, topKTools?, topKSkills?)`** — returns `{tools: {groups: [{server: {name, ...}, hits: [{toolId, score, description, inputSchema}, ...]}]}, skills: [...]}`
- **`invoke_tool(toolId, args)`** — runs `catalog[toolId].execute(args)`; returns `{"error": "..."}` if the id is unknown or the call throws

When the top-K covers the request, the model calls one directly and answers. When it doesn't, the model calls `search_capabilities` to discover candidates, then `invoke_tool` with the chosen id and args. Pydantic AI's agent loop auto-executes tools and threads their results back to the model until it emits final text.

## Why it's a separate package

Examples don't ship in `ratel-ai` — keeping them out of the published wheel keeps the public API surface narrow and dependency-free. This example pulls `pydantic-ai` only here.
