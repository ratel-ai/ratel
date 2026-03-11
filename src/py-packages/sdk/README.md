# agentified (Python SDK)

Register 200 tools. Get the 5 that matter. Python.

Async and sync clients for [Agentified](../../../README.md) — tool registration, context-aware [discovery](../../../docs/server/ranking.md), [session tracking](../../../docs/server/session-continuity.md), and message persistence. See the [LangGraph guide](../../../docs/python/integrations/langgraph.md) for a full walkthrough.

## Install

```bash
pip install agentified
```

Requires Python >= 3.10.

## Quick Start

```python
import asyncio
from agentified import Agentified, BackendTool, RegisterInput

async def main():
    ag = Agentified()
    await ag.connect("http://localhost:9119")

    instance = await ag.register(RegisterInput(tools=[
        BackendTool(name="get_weather", description="Get current weather",
                    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
                    handler=lambda args: {"temp": 22, "city": args["city"]}),
    ]))
    session = instance.session("my-session")

    # Discover relevant tools
    discovered = await session.discover_tool.execute({"query": "weather in Rome"})
    # [RankedTool(name='get_weather', score=0.92, ...)]

    # Persist conversation
    await session.update_conversation([
        {"role": "user", "content": "What's the weather in Rome?"},
        {"role": "assistant", "content": "It's 22°C in Rome."},
    ])

    # Assemble context
    ctx = await session.context.messages(strategy="recent").assemble()

    await ag.disconnect()

asyncio.run(main())
```

## API Hierarchy

```
Agentified
  ├── connect(server_url) → health check, store url
  ├── disconnect() → cleanup
  ├── dataset(name) → DatasetRef
  │    └── register(RegisterInput) → Instance
  └── register(RegisterInput) → Instance (default dataset)

Instance
  ├── discover_tool → DiscoverTool
  ├── session(id) → Session (namespace="default")
  └── namespace(id) → Namespace
       └── session(id) → Session

Session
  ├── conversation → Conversation
  │    ├── append(messages) → AppendMessagesResponse
  │    └── messages(opts?) → list[StoredMessage]
  ├── context → ContextBuilder (new each access)
  │    ├── messages(strategy?, max_tokens?) → self (fluent)
  │    ├── recall() → self (stub)
  │    └── assemble() → AssembledContext
  ├── discover_tool → DiscoverTool
  ├── get_messages(opts?) → GetMessagesResult
  └── update_conversation(messages) → None (with dedup)
```

## `Agentified` (async)

```python
ag = Agentified()
await ag.connect("http://localhost:9119")
# ... use ag ...
await ag.disconnect()
```

Or as context manager:

```python
async with Agentified() as ag:
    await ag.connect("http://localhost:9119")
    # auto-disconnects on exit
```

### `ag.register(input)`

```python
instance = await ag.register(RegisterInput(tools=[
    BackendTool(name="t1", description="...", parameters={...}, handler=my_handler),
]))
```

### `ag.dataset(name)`

```python
ref = ag.dataset("custom-dataset")
instance = await ref.register(RegisterInput(tools=[...]))
```

## `Session`

```python
session = instance.session("my-session")
```

### `session.update_conversation(messages)`

Persists messages with deduplication (won't re-append already-stored messages):

```python
await session.update_conversation([
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "hi"},
])
```

### `session.get_messages(opts?)`

```python
result = await session.get_messages(GetMessagesOptions(strategy="recent", max_messages=10))
# result.messages, result.total_messages, result.strategy_used
```

### `session.context` (ContextBuilder)

Fluent API for assembling context:

```python
ctx = await session.context.messages(strategy="recent", max_tokens=4000).assemble()
# ctx.messages, ctx.strategy_used, ctx.token_estimate, ctx.recalled
```

### `session.discover_tool`

```python
discovered = await session.discover_tool.execute({"query": "weather tools", "limit": 5})
```

## `SyncAgentified`

Synchronous wrapper for `connect`/`disconnect`/`register`/`dataset`:

```python
from agentified import SyncAgentified, BackendTool, RegisterInput

client = SyncAgentified()
client.connect("http://localhost:9119")
instance = client.register(RegisterInput(tools=[...]))
# Instance, Session, etc. are async-only — use asyncio.run() for deeper layers
client.disconnect()
```

## Events

Subscribe via `on_event` on `ApiClientConfig`:

```python
def handle_event(event):
    match event.type:
        case "agentified:prefetch:start":     ...
        case "agentified:prefetch:complete":  ...
        case "agentified:discover:start":     ...
        case "agentified:discover:complete":  ...
```

## LangGraph Example

```python
from agentified import Agentified, BackendTool, RegisterInput
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

ag = Agentified()
await ag.connect("http://localhost:9119")
instance = await ag.register(RegisterInput(tools=[...]))
session = instance.session("my-session")

# Discover relevant tools
discovered = await session.discover_tool.execute({"query": "weather"})
lc_tools = [StructuredTool.from_function(func=handler, name=t.name, description=t.description) for t in discovered]

# Run LangGraph agent with filtered tools
llm = ChatOpenAI(model="gpt-4o-mini")
agent = create_react_agent(llm, lc_tools)
result = await agent.ainvoke({"messages": [{"role": "user", "content": "What's the weather?"}]})
```

See [examples/py-langchain-sdk-smoke/](../../../examples/py-langchain-sdk-smoke/) for a complete working example.

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [LangGraph guide](../../../docs/python/integrations/langgraph.md) — Full Python walkthrough
- [Architecture](../../../docs/server/architecture.md)
- [agentified-core](../../core/README.md)
- [TypeScript SDK](../../ts-packages/sdk/README.md)

## License

[MIT](../../../LICENSE.md#mit-license)
