from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, create_model
from langchain_core.tools import StructuredTool

from agentified import (
    Agentified,
    AssembledContext,
    ContextBuilder,
    DatasetRef,
    Instance,
    Namespace,
    RegisterInput,
    Session,
)
from agentified.events import (
    Listener,
    ObserverEventName,
    Unsubscribe,
)
from agentified.models import (
    AgentifiedTool,
    BackendTool,
    ClientTool,
    DiscoverTool,
    DiscoverToolInput,
    GetMessagesTool,
    GetMessagesToolInput,
    McpTool,
    RecallConfig,
    SearchStrategy,
)


# --- Helpers ---

def _json_schema_to_pydantic(schema: dict[str, Any]) -> type[BaseModel]:
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    fields: dict[str, Any] = {}
    type_map = {"string": str, "number": float, "integer": int, "boolean": bool}
    for name, spec in props.items():
        py_type = type_map.get(spec.get("type", "string"), str)
        desc = spec.get("description", "")
        if name in required:
            fields[name] = (py_type, Field(description=desc))
        else:
            fields[name] = (py_type | None, Field(default=None, description=desc))
    return create_model("DynamicInput", **fields)


def _build_lc_tool_map(tools: list[AgentifiedTool]) -> dict[str, StructuredTool]:
    result: dict[str, StructuredTool] = {}
    for t in tools:
        if isinstance(t, ClientTool):
            continue  # Client tools have no handler
        if not isinstance(t, (BackendTool, McpTool)):
            continue

        input_model = _json_schema_to_pydantic(t.parameters)

        async def _handler(h=t.handler, **kwargs: Any) -> Any:
            r = h(kwargs)
            if hasattr(r, "__await__"):
                return await r
            return r

        result[t.name] = StructuredTool.from_function(
            coroutine=_handler,
            name=t.name,
            description=t.description,
            args_schema=input_model,
        )
    return result


def _wrap_discover_tool(dt: DiscoverTool) -> StructuredTool:
    async def _execute(**kwargs: Any) -> list[dict[str, Any]]:
        inp = DiscoverToolInput(**kwargs)
        result = await dt.execute(inp)
        return [{"name": t.name, "description": t.description, "score": t.score} for t in result]

    return StructuredTool.from_function(
        coroutine=_execute,
        name=dt.definition.name,
        description=dt.definition.description,
        args_schema=_json_schema_to_pydantic(dt.definition.parameters),
    )


def _wrap_get_messages_tool(gmt: GetMessagesTool) -> StructuredTool:
    async def _execute(**kwargs: Any) -> dict[str, Any]:
        inp = GetMessagesToolInput(**kwargs)
        result = await gmt.execute(inp)
        return result.model_dump()

    return StructuredTool.from_function(
        coroutine=_execute,
        name=gmt.definition.name,
        description=gmt.definition.description,
        args_schema=_json_schema_to_pydantic(gmt.definition.parameters),
    )


# --- Wrapper classes ---

class LangchainAssembledContext:
    def __init__(self, sdk_ctx: AssembledContext, tools: dict[str, StructuredTool]) -> None:
        self._sdk_ctx = sdk_ctx
        self.tools = tools

    @property
    def messages(self):
        return self._sdk_ctx.messages

    @property
    def recalled(self):
        return self._sdk_ctx.recalled

    @property
    def strategy_used(self):
        return self._sdk_ctx.strategy_used

    @property
    def fallback(self):
        return self._sdk_ctx.fallback

    @property
    def token_estimate(self):
        return self._sdk_ctx.token_estimate

    @property
    def conversation_messages(self):
        return self._sdk_ctx.conversation_messages

    @property
    def total_messages(self):
        return self._sdk_ctx.total_messages

    @property
    def included_messages(self):
        return self._sdk_ctx.included_messages

    @property
    def summary(self):
        return self._sdk_ctx.summary

    @property
    def summary_range(self):
        return self._sdk_ctx.summary_range


class LangchainContextBuilder:
    def __init__(
        self,
        sdk_builder: ContextBuilder,
        discover_tool: StructuredTool,
        discovered_names: set[str],
        lc_tool_cache: dict[str, StructuredTool],
    ) -> None:
        self._sdk_builder = sdk_builder
        self._discover_tool = discover_tool
        self._discovered_names = discovered_names
        self._lc_tool_cache = lc_tool_cache
        self._explicit_tools: dict[str, StructuredTool] = {}

    def messages(self, **kwargs: Any) -> LangchainContextBuilder:
        self._sdk_builder.messages(**kwargs)
        return self

    def tools(self, tools: dict[str, StructuredTool]) -> LangchainContextBuilder:
        self._explicit_tools.update(tools)
        return self

    def recall(self, config: RecallConfig | None = None) -> LangchainContextBuilder:
        self._sdk_builder.recall(config)
        return self

    def limit_tokens(self, budget: int) -> LangchainContextBuilder:
        self._sdk_builder.limit_tokens(budget)
        return self

    async def assemble(self) -> LangchainAssembledContext:
        sdk_ctx = await self._sdk_builder.assemble()

        resolved: dict[str, StructuredTool] = {**self._explicit_tools}
        for name in self._discovered_names:
            if name not in resolved and name in self._lc_tool_cache:
                resolved[name] = self._lc_tool_cache[name]

        return LangchainAssembledContext(sdk_ctx, resolved)


class LangchainSession:
    def __init__(self, sess: Session, lc_tool_cache: dict[str, StructuredTool]) -> None:
        self._sess = sess
        self._lc_tool_cache = lc_tool_cache
        self.discover_tool = _wrap_discover_tool(sess.discover_tool)
        self._get_messages_tool: StructuredTool | None = None

    @property
    def id(self) -> str:
        return self._sess.id

    @property
    def namespace_id(self) -> str:
        return self._sess.namespace_id

    @property
    def conversation(self):
        return self._sess.conversation

    @property
    def get_messages_tool(self) -> StructuredTool:
        if self._get_messages_tool is None:
            self._get_messages_tool = _wrap_get_messages_tool(self._sess.get_messages_tool)
        return self._get_messages_tool

    @property
    def context(self) -> LangchainContextBuilder:
        return LangchainContextBuilder(
            self._sess.context,
            self.discover_tool,
            self._sess.discover_tool.discovered_names,
            self._lc_tool_cache,
        )

    def get_tools(self) -> list[StructuredTool]:
        tools: list[StructuredTool] = [self.discover_tool]
        for name in self._sess.discover_tool.discovered_names:
            if name in self._lc_tool_cache:
                tools.append(self._lc_tool_cache[name])
        return tools

    async def get_messages(self, *args: Any, **kwargs: Any):
        return await self._sess.get_messages(*args, **kwargs)

    async def update_conversation(self, *args: Any, **kwargs: Any):
        return await self._sess.update_conversation(*args, **kwargs)


class LangchainNamespace:
    def __init__(self, ns: Namespace, lc_tool_cache: dict[str, StructuredTool]) -> None:
        self._ns = ns
        self._lc_tool_cache = lc_tool_cache

    @property
    def id(self) -> str:
        return self._ns.id

    def session(self, id: str) -> LangchainSession:
        return LangchainSession(self._ns.session(id), self._lc_tool_cache)


class LangchainInstance:
    def __init__(self, inst: Instance, tools: list[AgentifiedTool]) -> None:
        self._inst = inst
        self._lc_tool_cache = _build_lc_tool_map(tools)
        self.discover_tool = _wrap_discover_tool(inst.discover_tool)

    @property
    def instance_id(self) -> str:
        return self._inst.instance_id

    @property
    def dataset_id(self) -> str:
        return self._inst.dataset_id

    def on(self, name: ObserverEventName, cb: Listener) -> Unsubscribe:
        return self._inst.on(name, cb)

    def on_step_finish(self, data: dict) -> None:
        self._inst.on_step_finish(data)

    def get_tools(self) -> list[StructuredTool]:
        tools: list[StructuredTool] = [self.discover_tool]
        for name in self._inst.discover_tool.discovered_names:
            if name in self._lc_tool_cache:
                tools.append(self._lc_tool_cache[name])
        return tools

    def session(self, id: str) -> LangchainSession:
        return LangchainSession(self._inst.session(id), self._lc_tool_cache)

    def namespace(self, id: str) -> LangchainNamespace:
        return LangchainNamespace(self._inst.namespace(id), self._lc_tool_cache)


class LangchainDatasetRef:
    def __init__(self, ref: DatasetRef) -> None:
        self._ref = ref

    async def register(self, input: RegisterInput) -> LangchainInstance:
        inst = await self._ref.register(input)
        return LangchainInstance(inst, input.tools)


class LangchainAgentified:
    def __init__(self, ag: Agentified | None = None) -> None:
        self._ag = ag or Agentified()

    async def connect(
        self,
        server_url: str,
        *,
        headers: dict[str, str] | None = None,
        strategy: SearchStrategy | None = None,
    ) -> None:
        await self._ag.connect(server_url, headers=headers, strategy=strategy)

    async def disconnect(self) -> None:
        await self._ag.disconnect()

    def on(self, name: ObserverEventName, cb: Listener) -> Unsubscribe:
        return self._ag.on(name, cb)

    def dataset(self, name: str) -> LangchainDatasetRef:
        return LangchainDatasetRef(self._ag.dataset(name))

    async def register(self, input: RegisterInput) -> LangchainInstance:
        inst = await self._ag.register(input)
        return LangchainInstance(inst, input.tools)

    async def __aenter__(self) -> LangchainAgentified:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.disconnect()
