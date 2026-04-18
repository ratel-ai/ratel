# agentified-langchain

LangChain adapter for [Agentified](../../../README.md) — wraps SDK classes so that `session.context.assemble()` returns LangChain `StructuredTool` instances directly. No manual conversion needed.

## Install

```bash
pip install agentified-langchain
```

Requires Python >= 3.10. Peer dependencies: `agentified >= 0.2.0`, `langchain-core >= 0.3`.

## Quick Start

```python
from agentified_langchain import LangchainAgentified, BackendTool, RegisterInput
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

ag = LangchainAgentified()
await ag.connect("http://localhost:9119")

instance = await ag.register(RegisterInput(tools=[
    BackendTool(name="get_weather", description="Get current weather",
                parameters={"type": "object", "properties": {"city": {"type": "string"}}},
                handler=lambda args: {"temp": 22, "city": args["city"]}),
]))

session = instance.session("chat-1")

# Assemble context — tools are LangChain StructuredTools
ctx = await session.context.messages(strategy="recent").assemble()

# Pass directly to LangGraph
llm = ChatOpenAI(model="gpt-4o-mini")
agent = create_react_agent(llm, list(ctx.tools.values()))
result = await agent.ainvoke({"messages": [{"role": "user", "content": "What's the weather?"}]})
```

## Search Strategy

Pass a search strategy when connecting:

```python
await ag.connect("http://localhost:9119", strategy="hybrid")
```

## API Hierarchy

```
LangchainAgentified
  ├── connect(server_url, *, headers?, strategy?)
  ├── disconnect()
  ├── dataset(name) -> LangchainDatasetRef
  │    └── register(RegisterInput) -> LangchainInstance
  └── register(RegisterInput) -> LangchainInstance

LangchainInstance
  ├── discover_tool -> StructuredTool (agentified_discover)
  ├── get_tools() -> list[StructuredTool]
  ├── session(id) -> LangchainSession
  └── namespace(id) -> LangchainNamespace
       └── session(id) -> LangchainSession

LangchainSession
  ├── discover_tool -> StructuredTool
  ├── get_messages_tool -> StructuredTool (agentified_get_messages)
  ├── context -> LangchainContextBuilder
  │    ├── .tools(dict[str, StructuredTool]) -> self
  │    ├── .messages(strategy?, max_tokens?, keep_first?, prune_threshold?) -> self
  │    ├── .recall(config?) -> self
  │    ├── .limit_tokens(budget) -> self
  │    └── .assemble() -> LangchainAssembledContext
  ├── get_tools() -> list[StructuredTool]
  ├── conversation -> Conversation
  ├── get_messages(opts?) -> GetMessagesResult
  └── update_conversation(messages)
```

## `LangchainAssembledContext`

Returned by `.assemble()`. Tools are already `StructuredTool` instances:

```python
ctx = await session.context.messages(strategy="recent").assemble()

ctx.tools              # dict[str, StructuredTool] — explicit + discovered
ctx.messages           # list[StoredMessage]
ctx.token_estimate     # int
ctx.strategy_used      # str
ctx.recalled           # dict
ctx.summary            # str | None (compacted strategy only)
ctx.summary_range      # SummaryRange | None
```

## `LangchainContextBuilder`

Fluent API — chain `.tools()`, `.messages()`, `.recall()`, `.limit_tokens()`, then `.assemble()`:

```python
from agentified import RecallConfig

ctx = await session.context \
    .tools({"custom": my_structured_tool}) \
    .messages(strategy="recent", max_tokens=4000) \
    .recall(RecallConfig(tools=True)) \
    .limit_tokens(8000) \
    .assemble()
```

Explicit tools passed via `.tools()` are merged with auto-discovered tools.

## `LangchainSession.get_tools()`

Returns `discover_tool` + any tools discovered so far as `StructuredTool` instances:

```python
tools = session.get_tools()
# [StructuredTool(agentified_discover), StructuredTool(get_weather), ...]
```

## `LangchainSession.get_messages_tool`

Agent-callable tool for navigating message history:

```python
tool = session.get_messages_tool
# StructuredTool wrapping agentified_get_messages
```

## Observability

`LangchainAgentified` forwards `context_assembled` / `recall` events from the underlying SDK. `LangchainInstance` exposes a `step` event that fires once per agent step. Wire it from your LangGraph node post-hook (or any per-step callback).

```python
lc = LangchainAgentified()
await lc.connect("http://localhost:9119")
instance = await lc.register(RegisterInput(tools=[...]))

unsub = lc.on("context_assembled", lambda evt: metrics.emit("ctx", evt))
instance.on("step", lambda evt: metrics.emit("step", evt))

# Inside your LangGraph post-hook:
def post_hook(state, node_name):
    instance.on_step_finish({
        "step_index": state["step_index"],
        "tool_calls": state.get("tool_calls", []),
        "tool_results": state.get("tool_results", []),
        "usage": state.get("usage"),
        "finish_reason": state.get("finish_reason"),
    })
```

Supported events: `context_assembled`, `recall`, `step`. See the [Python SDK README](../sdk/README.md#observability) for payload details.

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [LangGraph guide](../../../docs/python/integrations/langgraph.md) — Full Python walkthrough
- [Python SDK](../sdk/README.md)
- [py-langchain-sdk-smoke example](../../../examples/py-langchain-sdk-smoke/) — Runnable smoke test

## License

[MIT](../../../LICENSE.md#mit-license)
