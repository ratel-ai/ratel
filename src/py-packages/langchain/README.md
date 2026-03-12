# agentified-langchain

LangChain adapter for [Agentified](../../../README.md) — wraps SDK classes so that `session.context.assemble()` returns LangChain `StructuredTool` instances directly. No manual conversion needed.

## Install

```bash
pip install agentified-langchain
```

Requires Python >= 3.10. Peer dependencies: `agentified >= 0.0.5`, `langchain-core >= 0.3`.

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

## API Hierarchy

```
LangchainAgentified
  ├── connect(server_url)
  ├── disconnect()
  ├── dataset(name) → LangchainDatasetRef
  │    └── register(RegisterInput) → LangchainInstance
  └── register(RegisterInput) → LangchainInstance

LangchainInstance
  ├── discover_tool → StructuredTool (agentified_discover)
  ├── get_tools() → list[StructuredTool]
  ├── session(id) → LangchainSession
  └── namespace(id) → LangchainNamespace
       └── session(id) → LangchainSession

LangchainSession
  ├── discover_tool → StructuredTool
  ├── context → LangchainContextBuilder
  │    ├── .tools(dict[str, StructuredTool]) → self
  │    ├── .messages(strategy?, max_tokens?) → self
  │    ├── .recall() → self
  │    └── .assemble() → LangchainAssembledContext
  ├── get_tools() → list[StructuredTool]
  ├── conversation → Conversation
  ├── get_messages(opts?) → GetMessagesResult
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
ctx.recalled           # list (stub)
```

## `LangchainContextBuilder`

Fluent API — chain `.tools()`, `.messages()`, `.recall()`, then `.assemble()`:

```python
ctx = await session.context \
    .tools({"custom": my_structured_tool}) \
    .messages(strategy="recent", max_tokens=4000) \
    .assemble()
```

Explicit tools passed via `.tools()` are merged with auto-discovered tools.

## `LangchainSession.get_tools()`

Returns `discover_tool` + any tools discovered so far as `StructuredTool` instances:

```python
tools = session.get_tools()
# [StructuredTool(agentified_discover), StructuredTool(get_weather), ...]
```

## Links

- [Root README](../../../README.md)
- [Documentation](../../../docs/)
- [LangGraph guide](../../../docs/python/integrations/langgraph.md) — Full Python walkthrough
- [Python SDK](../sdk/README.md)
- [py-langchain-sdk-smoke example](../../../examples/py-langchain-sdk-smoke/) — Runnable smoke test

## License

[MIT](../../../LICENSE.md#mit-license)
