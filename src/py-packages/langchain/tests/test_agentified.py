from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.tools import StructuredTool

from agentified.models import (
    ApiClientConfig,
    BackendTool,
    ContextResponse,
    DiscoverTool,
    DiscoverToolInput,
    RankedTool,
    RegisterInput,
    StoredMessage,
    ToolDefinition,
)
from agentified.api_client import ApiClient
from agentified.instance import Instance
from agentified.session import Session
from agentified.namespace import Namespace
from agentified.context_builder import ContextBuilder

from agentified_langchain.agentified import (
    LangchainAgentified,
    LangchainAssembledContext,
    LangchainContextBuilder,
    LangchainDatasetRef,
    LangchainInstance,
    LangchainNamespace,
    LangchainSession,
    _build_lc_tool_map,
    _json_schema_to_pydantic,
    _wrap_discover_tool,
)

from conftest import BACKEND_TOOLS, RANKED_TOOL, TEST_URL


# --- Helper tests ---

class TestJsonSchemaToPydantic:
    def test_creates_model_with_required_fields(self):
        schema = {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name"}},
            "required": ["city"],
        }
        model = _json_schema_to_pydantic(schema)
        instance = model(city="Rome")
        assert instance.city == "Rome"

    def test_creates_model_with_optional_fields(self):
        schema = {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        }
        model = _json_schema_to_pydantic(schema)
        instance = model(query="test")
        assert instance.query == "test"
        assert instance.limit is None

    def test_handles_empty_schema(self):
        model = _json_schema_to_pydantic({})
        instance = model()
        assert instance is not None

    def test_maps_types_correctly(self):
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "count": {"type": "integer"},
                "score": {"type": "number"},
                "active": {"type": "boolean"},
            },
            "required": ["name", "count", "score", "active"],
        }
        model = _json_schema_to_pydantic(schema)
        instance = model(name="x", count=1, score=0.5, active=True)
        assert isinstance(instance.name, str)
        assert isinstance(instance.count, int)
        assert isinstance(instance.score, float)
        assert isinstance(instance.active, bool)


class TestBuildLcToolMap:
    def test_converts_backend_tools_to_structured_tools(self):
        result = _build_lc_tool_map(BACKEND_TOOLS)
        assert "get_weather" in result
        assert "search_docs" in result
        assert isinstance(result["get_weather"], StructuredTool)

    def test_preserves_tool_names_and_descriptions(self):
        result = _build_lc_tool_map(BACKEND_TOOLS)
        assert result["get_weather"].name == "get_weather"
        assert result["get_weather"].description == "Get weather for a city"

    def test_empty_tools_returns_empty_dict(self):
        assert _build_lc_tool_map([]) == {}


class TestWrapDiscoverTool:
    def test_wraps_as_structured_tool(self):
        dt = DiscoverTool(
            definition=ToolDefinition(
                name="agentified_discover",
                description="Find tools",
                parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            ),
            execute=AsyncMock(return_value=[]),
        )
        lc_tool = _wrap_discover_tool(dt)
        assert isinstance(lc_tool, StructuredTool)
        assert lc_tool.name == "agentified_discover"

    async def test_executes_and_returns_dicts(self):
        dt = DiscoverTool(
            definition=ToolDefinition(
                name="agentified_discover",
                description="Find tools",
                parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            ),
            execute=AsyncMock(return_value=[RANKED_TOOL]),
        )
        lc_tool = _wrap_discover_tool(dt)
        result = await lc_tool.ainvoke({"query": "weather"})
        assert len(result) == 1
        assert result[0]["name"] == "get_weather"
        assert result[0]["score"] == 0.95


# --- Wrapper class tests ---

def _make_sdk() -> ApiClient:
    return ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))


def _make_instance(tools: list[BackendTool] = BACKEND_TOOLS) -> Instance:
    sdk = _make_sdk()
    return Instance("inst1", "ds1", sdk, tools)


def _make_session(tools: list[BackendTool] = BACKEND_TOOLS) -> Session:
    sdk = _make_sdk()
    return Session("s1", "default", sdk, "ds1", tools)


class TestLangchainInstance:
    def test_wraps_instance_properties(self):
        inst = _make_instance()
        lc_inst = LangchainInstance(inst, BACKEND_TOOLS)
        assert lc_inst.instance_id == "inst1"
        assert lc_inst.dataset_id == "ds1"

    def test_discover_tool_is_structured_tool(self):
        inst = _make_instance()
        lc_inst = LangchainInstance(inst, BACKEND_TOOLS)
        assert isinstance(lc_inst.discover_tool, StructuredTool)
        assert lc_inst.discover_tool.name == "agentified_discover"

    def test_get_tools_returns_discover_initially(self):
        inst = _make_instance()
        lc_inst = LangchainInstance(inst, BACKEND_TOOLS)
        tools = lc_inst.get_tools()
        assert len(tools) == 1
        assert tools[0].name == "agentified_discover"

    def test_get_tools_includes_discovered(self):
        inst = _make_instance()
        inst.discover_tool.discovered_names.add("get_weather")
        lc_inst = LangchainInstance(inst, BACKEND_TOOLS)
        tools = lc_inst.get_tools()
        names = [t.name for t in tools]
        assert "agentified_discover" in names
        assert "get_weather" in names

    def test_session_returns_langchain_session(self):
        inst = _make_instance()
        lc_inst = LangchainInstance(inst, BACKEND_TOOLS)
        sess = lc_inst.session("s1")
        assert isinstance(sess, LangchainSession)

    def test_namespace_returns_langchain_namespace(self):
        inst = _make_instance()
        lc_inst = LangchainInstance(inst, BACKEND_TOOLS)
        ns = lc_inst.namespace("ns1")
        assert isinstance(ns, LangchainNamespace)


class TestLangchainSession:
    def test_wraps_session_properties(self):
        sess = _make_session()
        lc_sess = LangchainSession(sess, _build_lc_tool_map(BACKEND_TOOLS))
        assert lc_sess.id == "s1"
        assert lc_sess.namespace_id == "default"

    def test_discover_tool_is_structured_tool(self):
        sess = _make_session()
        lc_sess = LangchainSession(sess, _build_lc_tool_map(BACKEND_TOOLS))
        assert isinstance(lc_sess.discover_tool, StructuredTool)

    def test_get_tools_returns_discover_initially(self):
        sess = _make_session()
        lc_sess = LangchainSession(sess, _build_lc_tool_map(BACKEND_TOOLS))
        tools = lc_sess.get_tools()
        assert len(tools) == 1
        assert tools[0].name == "agentified_discover"

    def test_get_tools_includes_discovered(self):
        sess = _make_session()
        sess.discover_tool.discovered_names.add("search_docs")
        lc_sess = LangchainSession(sess, _build_lc_tool_map(BACKEND_TOOLS))
        tools = lc_sess.get_tools()
        names = [t.name for t in tools]
        assert "agentified_discover" in names
        assert "search_docs" in names

    def test_context_returns_langchain_context_builder(self):
        sess = _make_session()
        lc_sess = LangchainSession(sess, _build_lc_tool_map(BACKEND_TOOLS))
        ctx = lc_sess.context
        assert isinstance(ctx, LangchainContextBuilder)


class TestLangchainNamespace:
    def test_wraps_namespace_properties(self):
        sdk = _make_sdk()
        ns = Namespace("ns1", sdk, "ds1", BACKEND_TOOLS)
        lc_ns = LangchainNamespace(ns, _build_lc_tool_map(BACKEND_TOOLS))
        assert lc_ns.id == "ns1"

    def test_session_returns_langchain_session(self):
        sdk = _make_sdk()
        ns = Namespace("ns1", sdk, "ds1", BACKEND_TOOLS)
        lc_ns = LangchainNamespace(ns, _build_lc_tool_map(BACKEND_TOOLS))
        sess = lc_ns.session("s1")
        assert isinstance(sess, LangchainSession)


class TestLangchainContextBuilder:
    def _make_builder(self, discovered: set[str] | None = None) -> LangchainContextBuilder:
        sdk = _make_sdk()
        sdk_builder = ContextBuilder(
            sdk, "ds1", "ns", "sess",
            registered_tools=BACKEND_TOOLS,
            discovered_names=discovered or set(),
        )
        lc_cache = _build_lc_tool_map(BACKEND_TOOLS)
        discover = _wrap_discover_tool(DiscoverTool(
            definition=ToolDefinition(name="agentified_discover", description="Find", parameters={}),
            execute=AsyncMock(return_value=[]),
            discovered_names=discovered or set(),
        ))
        return LangchainContextBuilder(sdk_builder, discover, discovered or set(), lc_cache)

    def test_tools_is_chainable(self):
        builder = self._make_builder()
        result = builder.tools({"a": MagicMock()})
        assert result is builder

    def test_messages_is_chainable(self):
        builder = self._make_builder()
        result = builder.messages(strategy="recent")
        assert result is builder

    def test_recall_is_chainable(self):
        builder = self._make_builder()
        result = builder.recall()
        assert result is builder

    @patch.object(ContextBuilder, "assemble")
    async def test_assemble_resolves_discovered_tools(self, mock_assemble):
        from agentified.models import AssembledContext
        mock_assemble.return_value = AssembledContext(
            messages=[], recalled={}, strategy_used="recent",
            fallback=False, token_estimate=0, conversation_messages=0,
            total_messages=0, included_messages=0, tools={},
        )
        builder = self._make_builder(discovered={"get_weather"})
        result = await builder.assemble()

        assert isinstance(result, LangchainAssembledContext)
        assert "get_weather" in result.tools
        assert isinstance(result.tools["get_weather"], StructuredTool)
        assert "search_docs" not in result.tools

    @patch.object(ContextBuilder, "assemble")
    async def test_explicit_tools_override_discovered(self, mock_assemble):
        from agentified.models import AssembledContext
        mock_assemble.return_value = AssembledContext(
            messages=[], recalled={}, strategy_used="recent",
            fallback=False, token_estimate=0, conversation_messages=0,
            total_messages=0, included_messages=0, tools={},
        )
        custom = MagicMock(spec=StructuredTool)
        builder = self._make_builder(discovered={"get_weather"})
        result = await builder.tools({"get_weather": custom}).assemble()

        assert result.tools["get_weather"] is custom


class TestLangchainAssembledContext:
    def test_exposes_sdk_properties(self):
        from agentified.models import AssembledContext
        sdk_ctx = AssembledContext(
            messages=[], recalled={"tools": []}, strategy_used="recent",
            fallback=False, token_estimate=10, conversation_messages=5,
            total_messages=5, included_messages=5, tools={},
        )
        lc_ctx = LangchainAssembledContext(sdk_ctx, {"a": MagicMock()})
        assert lc_ctx.strategy_used == "recent"
        assert lc_ctx.token_estimate == 10
        assert lc_ctx.fallback is False
        assert "a" in lc_ctx.tools


class TestLangchainAgentified:
    async def test_connect_delegates(self):
        ag = MagicMock()
        ag.connect = AsyncMock()
        lc = LangchainAgentified(ag)
        await lc.connect("http://localhost:9119")
        ag.connect.assert_called_once_with("http://localhost:9119")

    async def test_disconnect_delegates(self):
        ag = MagicMock()
        ag.disconnect = AsyncMock()
        lc = LangchainAgentified(ag)
        await lc.disconnect()
        ag.disconnect.assert_called_once()

    def test_dataset_returns_langchain_dataset_ref(self):
        ag = MagicMock()
        ag.dataset.return_value = MagicMock()
        lc = LangchainAgentified(ag)
        ref = lc.dataset("myds")
        assert isinstance(ref, LangchainDatasetRef)

    async def test_context_manager(self):
        ag = MagicMock()
        ag.disconnect = AsyncMock()
        lc = LangchainAgentified(ag)
        async with lc:
            pass
        ag.disconnect.assert_called_once()
