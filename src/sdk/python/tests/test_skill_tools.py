"""Tests for get_skill_content_tool — mirrors `src/sdk/ts/src/skill-tools.test.ts`."""

from ratel_ai import GET_SKILL_CONTENT_ID, Skill, SkillCatalog, get_skill_content_tool


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


def test_output_schema_accepts_error_shape_not_just_body() -> None:
    # An MCP client validates structured content against outputSchema; the error
    # branch returns { error } with no body, so body must NOT be required.
    schema = get_skill_content_tool(SkillCatalog()).output_schema
    assert "body" not in schema.get("required", [])
    assert "body" in schema["properties"]
    assert "error" in schema["properties"]


def _deck_outlining() -> Skill:
    return Skill(
        id="deck-outlining",
        name="deck-outlining",
        description="Outline the narrative structure of a slide deck.",
        body="# Deck Outlining",
    )


def _api_design(**overrides) -> Skill:
    fields = {
        "id": "api-design",
        "name": "api-design",
        "description": "REST API design patterns.",
        "body": "# API\n\nUse nouns.",
        **overrides,
    }
    return Skill(**fields)


async def test_lists_declared_skill_deps_with_id_and_compacted_description() -> None:
    tool = get_skill_content_tool(
        _catalog(_api_design(skills=["deck-outlining"]), _deck_outlining())
    )
    result = await tool.execute({"skillId": "api-design"})
    assert "Use nouns" in result["body"]
    assert result["skills"] == [
        {
            "skillId": "deck-outlining",
            "description": "Outline the narrative structure of a slide deck.",
        }
    ]


async def test_omits_skills_listing_when_no_deps() -> None:
    tool = get_skill_content_tool(_catalog(_api_design()))
    result = await tool.execute({"skillId": "api-design"})
    assert "skills" not in result


async def test_skips_unknown_dep_ids_omitting_listing_if_none_remain() -> None:
    tool = get_skill_content_tool(
        _catalog(_api_design(skills=["ghost-skill", "deck-outlining"]), _deck_outlining())
    )
    result = await tool.execute({"skillId": "api-design"})
    assert [s["skillId"] for s in result["skills"]] == ["deck-outlining"]

    all_unknown = get_skill_content_tool(_catalog(_api_design(skills=["ghost-skill"])))
    result2 = await all_unknown.execute({"skillId": "api-design"})
    assert "skills" not in result2


def test_output_schema_declares_skills_without_requiring_it() -> None:
    schema = get_skill_content_tool(SkillCatalog()).output_schema
    assert "skills" in schema["properties"]
    assert "skills" not in schema.get("required", [])
