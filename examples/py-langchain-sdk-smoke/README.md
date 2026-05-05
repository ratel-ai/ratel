# py-langchain-sdk-smoke

Smoke test for the Python SDK with LangChain/LangGraph integration.

## Prerequisites

```bash
export OPENAI_API_KEY=sk-...

docker run -p 9119:9119 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e AGENTIFIED_STORAGE=sqlite \
  agentified/agentified-core
```

## Run

```bash
uv run python main.py
```

## Checks

1. Connect to agentified-core
2. Register tools (get_weather, search_docs)
3. Create session
4. Discover tools via `discover_tool.execute()`
5. Convert discovered tools to LangChain `StructuredTool`
6. Run LangGraph ReAct agent with filtered tools
7. Verify tool calling works
8. Test session continuity (persist + read messages)
