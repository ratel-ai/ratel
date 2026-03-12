# agentified (Python SDK)

Context intelligence for AI agents. Register tools, assemble the right context per turn. Python.

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

    session = instance.session("chat-1")

    # Assemble context — tools + messages for this turn
    ctx = await session.context.messages(strategy="recent").assemble()
    # ctx.tools       → discovered tools ranked by relevance
    # ctx.messages    → conversation history
    # ctx.token_estimate → estimated token count

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

## LangChain / LangGraph Integration

Use the `agentified-langchain` adapter for native LangChain tool injection:

```python
from agentified_langchain import LangchainAgentified, BackendTool, RegisterInput
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

ag = LangchainAgentified()
await ag.connect("http://localhost:9119")
instance = await ag.register(RegisterInput(tools=[...]))
session = instance.session("my-session")

# Assemble context — tools are already LangChain StructuredTools
ctx = await session.context.messages(strategy="recent").assemble()

llm = ChatOpenAI(model="gpt-4o-mini")
agent = create_react_agent(llm, list(ctx.tools.values()))
result = await agent.ainvoke({"messages": ctx.messages})
```

See [agentified-langchain README](../../py-packages/langchain/README.md) for full docs, or [py-langchain-sdk-smoke](../../../examples/py-langchain-sdk-smoke/) for a working example.

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [LangGraph guide](../../../docs/python/integrations/langgraph.md) — Full Python walkthrough
- [Architecture](../../../docs/server/architecture.md)
- [agentified-core](../../core/README.md)
- [TypeScript SDK](../../ts-packages/sdk/README.md)

## License

[MIT](../../../LICENSE.md#mit-license)
