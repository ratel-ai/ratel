"""Tests for get_skill_content_tool — mirrors `src/sdk/ts/src/skill-gateway.test.ts`."""

from ratel_ai import (
    GET_SKILL_CONTENT_ID,
    Skill,
    SkillCatalog,
    TraceSinkConfig,
    get_skill_content_tool,
)


def _catalog(*skills: Skill) -> SkillCatalog:
    c = SkillCatalog()
    for s in skills:
        c.register(s)
    return c


def test_uses_the_canonical_id() -> None:
    tool = get_skill_content_tool(SkillCatalog())
    assert tool.id == GET_SKILL_CONTENT_ID == "get_skill_content"


async def test_returns_skill_body_by_id() -> None:
    tool = get_skill_content_tool(
        _catalog(
            Skill(id="api-design", name="api-design", description="d", body="# API\n\nUse nouns.")
        )
    )
    result = await tool.execute({"skillId": "api-design"})
    assert "Use nouns" in result["body"]


async def test_unknown_id_returns_structured_error_with_is_error() -> None:
    tool = get_skill_content_tool(SkillCatalog())
    result = await tool.execute({"skillId": "nope"})
    assert "unknown skillId: nope" in result["error"]
    assert result["isError"] is True


async def test_missing_skill_id_returns_error_not_keyerror() -> None:
    tool = get_skill_content_tool(SkillCatalog())
    # No "skillId" key at all — recoverable structured error, not a KeyError (TS parity).
    result = await tool.execute({})
    assert "unknown skillId" in result["error"]
    assert result["isError"] is True


async def test_unknown_id_emits_gateway_error_with_structured_code() -> None:
    catalog = SkillCatalog(trace=TraceSinkConfig(kind="memory", session_id="t"))
    tool = get_skill_content_tool(catalog)
    await tool.execute({"skillId": "nope"})
    events = catalog.drain_trace_events()
    err = next(e for e in events if e["type"] == "gateway_error")
    assert err["tool_id"] == "nope"
    assert err["error"] == "unknown_skill_id"
    assert err["error_code"] == "unknown_skill_id"
    assert err["error_kind"] == "permanent"


def test_output_schema_accepts_error_shape_not_just_body() -> None:
    # An MCP client validates structured content against outputSchema; the error
    # branch returns { error } with no body, so body must NOT be required.
    schema = get_skill_content_tool(SkillCatalog()).output_schema
    assert "body" not in schema.get("required", [])
    assert "body" in schema["properties"]
    assert "error" in schema["properties"]
