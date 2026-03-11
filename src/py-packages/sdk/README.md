# agentified (Python SDK)

Register 200 tools. Get the 5 that matter. Python.

Async and sync clients for [Agentified](../../../README.md) — tool registration, context-aware [discovery](../../../docs/server/ranking.md), and [session tracking](../../../docs/server/session-continuity.md). See the [LangGraph guide](../../../docs/python/integrations/langgraph.md) for a full walkthrough.

## Install

```bash
pip install agentified
```

Requires Python >= 3.10.

## Quick Start

```python
from agentified import Agentified, AgentifiedConfig, tool

async with Agentified(AgentifiedConfig(
    server_url="http://localhost:9119",
    tools=[
        tool(name="get_weather", description="Get current weather", parameters={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
        tool(name="book_flight", description="Book a flight", parameters={"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}}, "required": ["from", "to"]}),
    ],
)) as agent:
    await agent.register()
    ranked = await agent.prefetch(messages=[{"role": "user", "content": "What's the weather in Rome?"}])
    # [RankedTool(name='get_weather', score=0.92, ...)]
```

## API Reference

### `tool()`

Creates a `ServerTool` with auto-populated fields for embedding.

```python
from agentified import tool

t = tool(
    name="search_docs",
    description="Search documentation by keyword",
    parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    metadata={"category": "search"},  # optional
)
```

### `Agentified` (async)

```python
from agentified import Agentified, AgentifiedConfig

config = AgentifiedConfig(
    server_url="http://localhost:9119",
    tools=[...],
    on_event=lambda e: print(e),  # optional
)

async with Agentified(config) as agent:
    ...
```

#### `agent.register()`

```python
result = await agent.register()
# RegisterResponse(registered=10)
```

#### `agent.prefetch()`

```python
tools = await agent.prefetch(
    messages=[{"role": "user", "content": "Book a flight to Paris"}],
    limit=10,               # default 5
    exclude=["admin_tool"],  # optional
    turn_id="prev-turn-id", # optional, for session continuity
)
# list[RankedTool]
```

#### `agent.capture_turn()`

```python
result = await agent.capture_turn(
    tools_loaded=["get_weather", "book_flight"],
    message="What's the weather in Rome?",
)
# CaptureTurnResponse(turn_id="...")
```

#### `agent.get_frontend_tools()` / `agent.get_frontend_tool_names()`

Returns tools where `metadata.location == "frontend"`.

#### `agent.as_discover_tool()`

Returns a `DiscoverTool` with a `definition` and async `execute` callable.

```python
discover = agent.as_discover_tool()
# discover.definition → ToolDefinition(name="agentified_discover", ...)
# await discover.execute(DiscoverToolInput(query="weather", limit=5))
```

### `SyncAgentified`

Synchronous wrapper — same API, uses `asyncio.run()` internally.

```python
from agentified import SyncAgentified, AgentifiedConfig, tool

agent = SyncAgentified(AgentifiedConfig(
    server_url="http://localhost:9119",
    tools=[tool(name="ping", description="Ping", parameters={"type": "object", "properties": {}})],
))
agent.register()
ranked = agent.prefetch(messages=[{"role": "user", "content": "ping"}])
```

## Events

Subscribe via `on_event` in the config:

```python
def handle_event(event):
    match event.type:
        case "agentified:prefetch:start":     # PrefetchStartEvent
        case "agentified:prefetch:complete":  # PrefetchCompleteEvent
        case "agentified:prefetch:skipped":   # PrefetchSkippedEvent
        case "agentified:discover:start":     # DiscoverStartEvent
        case "agentified:discover:complete":  # DiscoverCompleteEvent

config = AgentifiedConfig(server_url="...", tools=[...], on_event=handle_event)
```

## LangGraph Example

```python
from agentified import Agentified, AgentifiedConfig, tool
from langgraph.prebuilt import create_react_agent
from langchain_google_genai import ChatGoogleGenerativeAI

tools_list = [
    tool(name="get_weather", description="Get weather", parameters={...}),
    tool(name="search_docs", description="Search docs", parameters={...}),
]

async with Agentified(AgentifiedConfig(
    server_url="http://localhost:9119",
    tools=tools_list,
)) as agent:
    await agent.register()

    # Prefetch relevant tools
    ranked = await agent.prefetch(messages=[{"role": "user", "content": "What's the weather?"}], limit=15)

    # Build LangChain tools from ranked results
    lc_tools = [build_langchain_tool(t) for t in ranked]

    # Create and run LangGraph agent
    llm = ChatGoogleGenerativeAI(model="gemini-3-flash-preview")
    graph = create_react_agent(llm, lc_tools)
    result = await graph.ainvoke({"messages": [{"role": "user", "content": "What's the weather?"}]})
```

See [examples/py-langgraph/](../../../examples/py-langgraph/) for a complete working example.

## Types

Core models are Pydantic v2 `BaseModel`s (`AgentifiedConfig` and `DiscoverTool` are dataclasses):

```python
class ServerTool:
    name: str
    description: str
    parameters: dict
    metadata: dict | None
    fields: ServerToolFields | None

class RankedTool(ServerTool):
    score: float
    graph_expanded: bool | None

class Message:
    role: str
    content: str

class RegisterResponse:
    registered: int

class CaptureTurnResponse:
    turn_id: str
```

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [LangGraph guide](../../../docs/python/integrations/langgraph.md) — Full Python walkthrough
- [Architecture](../../../docs/server/architecture.md)
- [agentified-core](../../core/README.md)
- [TypeScript SDK](../../ts-packages/sdk/README.md)
- [LangGraph Example](../../../examples/py-langgraph/)

## License

[MIT](../../../LICENSE.md#mit-license)
