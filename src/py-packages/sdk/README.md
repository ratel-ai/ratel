# agentified (Python SDK)

Context intelligence for AI agents. Register tools, assemble the right context per turn. Python.

Async and sync clients for [Agentified](../../../README.md) — tool registration, context-aware [discovery](../../../docs/server/ranking.md), [session tracking](../../../docs/server/session-continuity.md), and message persistence. See the [LangGraph guide](../../../docs/python/integrations/langgraph.md) for a full walkthrough.

## Install

```bash
pip install agentified
```

For MCP tool support:

```bash
pip install agentified[mcp]
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
    # ctx.tools       -> discovered tools ranked by relevance
    # ctx.messages    -> conversation history
    # ctx.token_estimate -> estimated token count

    await ag.disconnect()

asyncio.run(main())
```

## Authentication

Pass custom headers (e.g. for Cloud Run IAM, API gateways) via `connect()`:

```python
await ag.connect("https://my-service.run.app", headers={"Authorization": f"Bearer {identity_token}"})
```

Headers are sent on every request, including the initial health check.

## Search Strategy

Choose the discovery ranking algorithm:

```python
await ag.connect("http://localhost:9119", strategy="hybrid")
```

Available strategies:
- `"bm25"` (default) — lexical token-based ranking
- `"semantic"` — embedding-based cosine similarity (requires `OPENAI_API_KEY`)
- `"hybrid"` — 70% semantic + 30% BM25

## API Hierarchy

```
Agentified
  ├── connect(server_url, *, headers?, strategy?) -> health check, store url
  ├── disconnect() -> cleanup
  ├── dataset(name) -> DatasetRef
  │    └── register(RegisterInput) -> Instance
  └── register(RegisterInput) -> Instance (default dataset)

Instance
  ├── discover_tool -> DiscoverTool
  ├── session(id) -> Session (namespace="default")
  └── namespace(id) -> Namespace
       └── session(id) -> Session

Session
  ├── conversation -> Conversation
  │    ├── append(messages) -> AppendMessagesResponse
  │    └── messages(opts?) -> list[StoredMessage]
  ├── context -> ContextBuilder (new each access)
  │    ├── messages(strategy?, max_tokens?, keep_first?, prune_threshold?, compaction_strategy?) -> self
  │    ├── tools(dict) -> self
  │    ├── recall(config?) -> self
  │    ├── limit_tokens(budget) -> self
  │    └── assemble() -> AssembledContext
  ├── discover_tool -> DiscoverTool
  ├── get_messages_tool -> GetMessagesTool
  ├── get_messages(opts?) -> GetMessagesResult
  └── update_conversation(messages) -> None (with dedup)
```

## Tool Types

### BackendTool

Server-side tools with a handler function:

```python
BackendTool(
    name="get_weather",
    description="Get current weather",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
    handler=lambda args: {"temp": 22},
    always_include=True,  # always present in agent context
)
```

### McpTool

Tools from MCP (Model Context Protocol) servers:

```python
McpTool(
    name="read_file",
    description="Read a file",
    parameters={"type": "object", "properties": {"path": {"type": "string"}}},
    server="http://localhost:3001/mcp",
    handler=my_handler,
)
```

Or use the `mcp_tools()` helper to auto-discover:

```python
from agentified import mcp_tools

tools = await mcp_tools(server="http://localhost:3001/mcp")
instance = await ag.register(RegisterInput(tools=tools))
```

## `Agentified` (async)

```python
ag = Agentified()
await ag.connect("http://localhost:9119")
# ... use ag ...
await ag.disconnect()

# With auth headers and search strategy:
await ag.connect("https://my-service.run.app", headers={"Authorization": "Bearer ..."}, strategy="hybrid")
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
ctx = await session.context \
    .messages(strategy="recent", max_tokens=4000, keep_first=True) \
    .recall(RecallConfig(tools=True)) \
    .limit_tokens(8000) \
    .assemble()
# ctx.messages, ctx.strategy_used, ctx.token_estimate, ctx.recalled
# ctx.tools -> dict of discovered tools
# ctx.summary -> optional LLM-generated summary (compacted strategy)
# ctx.summary_range -> SummaryRange with first_seq, last_seq, count
```

#### Recall

Recall persists discovered tools across turns within a session:

```python
# Simple recall (default: tools=True, limit=5)
ctx = await session.context.recall().assemble()

# With custom config
from agentified import RecallConfig, RecallToolsConfig
ctx = await session.context.recall(RecallConfig(
    tools=RecallToolsConfig(limit=3, min_similarity=0.5)
)).assemble()
```

#### Token Limiting

Cap the total context size (tools + messages):

```python
ctx = await session.context.limit_tokens(8000).assemble()
```

### `session.discover_tool`

```python
discovered = await session.discover_tool.execute({"query": "weather tools", "limit": 5})
```

### `session.get_messages_tool`

Agent-callable tool for navigating message history:

```python
result = await session.get_messages_tool.execute({"limit": 20, "after_seq": 5})
# result.messages, result.has_more, result.max_seq
```

## `SyncAgentified`

Synchronous wrapper for `connect`/`disconnect`/`register`/`dataset`:

```python
from agentified import SyncAgentified, BackendTool, RegisterInput

client = SyncAgentified()
client.connect("http://localhost:9119", strategy="bm25")
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

## Observability

Subscribe once at startup to receive events from every `.recall()` / `.assemble()`. Listeners can be sync or async (coroutines are scheduled on the running event loop).

```python
from agentified import Agentified

ag = Agentified()
await ag.connect("http://localhost:9119")

def on_ctx(evt):
    metrics.emit("ctx", evt)

unsub = ag.on("context_assembled", on_ctx)
ag.on("recall", lambda evt: print(f"recalled {len(evt.matches)} tools in {evt.duration_ms}ms"))

# later
unsub()
```

### Event names + payloads

| Event | Payload fields |
| --- | --- |
| `context_assembled` | `session_id`, `dataset_id`, `strategy_used`, `total_messages`, `included_messages`, `token_estimate`, `fallback`, `recalled: {"tools": [...]}`, `duration_ms` |
| `recall` | `session_id`, `dataset_id`, `config`, `matches`, `duration_ms` (only fires when `.recall(...)` was configured) |
| `step` | `session_id`, `step_index`, `tool_calls`, `tool_results`, `usage`, `finish_reason`, `duration_ms` — wire via `instance.on_step_finish(data)` from your agent's per-step callback (e.g. LangGraph node post-hook) |

Callbacks are fire-and-forget; errors are swallowed. `on(...)` returns a zero-arg disposer.

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [LangGraph guide](../../../docs/python/integrations/langgraph.md) — Full Python walkthrough
- [Architecture](../../../docs/server/architecture.md)
- [agentified-core](../../core/README.md)
- [TypeScript SDK](../../ts-packages/sdk/README.md)

## License

[MIT](../../../LICENSE.md#mit-license)
