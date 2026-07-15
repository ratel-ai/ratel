"""Skill content tool — the Python mirror of `src/sdk/ts/src/skill-tools.ts`.

`get_skill_content_tool` is the counterpart to `invoke_tool`: the agent discovers
a skill in the `skills` bucket of `search_capabilities`, then loads its full
playbook into context here. The tool description and schemas are a product
contract shown to the model — kept verbatim with the TS SDK.
"""

from __future__ import annotations

from typing import Any

from .capabilities import _compact_description
from .catalog import ExecutableTool
from .skill_catalog import SkillCatalog

GET_SKILL_CONTENT_ID = "get_skill_content"
"""Id (and name) of the skill-loading tool built by `get_skill_content_tool`."""

__all__ = ["GET_SKILL_CONTENT_ID", "get_skill_content_tool"]


def get_skill_content_tool(catalog: SkillCatalog) -> ExecutableTool:
    """Build the `get_skill_content` tool: load a skill's full body by id.

    The returned tool resolves `skillId` and answers `{"body": <markdown>}` via
    `SkillCatalog.invoke` (which records a `skill_invoke` trace event). When
    the skill declares dependencies on other skills, the result also carries
    `skills` — `[{skillId, description}]` for the declared ids the catalog
    knows, so the agent can recall them without another search; it is omitted
    when there are none. It never raises into the host: an unknown or
    non-string id comes back as a structured `{"error": ..., "isError": True}`
    payload the model can recover from, mirroring `invoke_tool`.

    Args:
        catalog: the skill catalog to load bodies from.

    Returns:
        An `ExecutableTool` to put in the agent's direct tool list alongside
        `search_capabilities`.
    """

    async def execute(input: dict[str, Any]) -> dict[str, Any]:
        skill_id = input.get("skillId")
        if not isinstance(skill_id, str) or not catalog.has(skill_id):
            # Missing/non-string id: structured error, not a KeyError — recoverable
            # rather than crashing the host (mirrors invoke_tool / the TS SDK).
            catalog.record_event(
                {
                    "type": "gateway_error",
                    "tool_id": skill_id if isinstance(skill_id, str) else "",
                    "error": "unknown_skill_id",
                }
            )
            return {
                "error": (
                    f"unknown skillId: {skill_id}. "
                    "Use search_capabilities to discover available ids."
                ),
                "isError": True,
            }
        body = catalog.invoke(skill_id)
        # Surface the skill's declared skill deps (known ids only) so the agent
        # can recall them with another get_skill_content call, no search needed.
        skill = catalog.get(skill_id)
        deps = []
        for dep_id in skill.skills if skill else []:
            dep = catalog.get(dep_id)
            if dep is not None:
                deps.append(
                    {"skillId": dep_id, "description": _compact_description(dep.description)}
                )
        return {"body": body, "skills": deps} if deps else {"body": body}

    return ExecutableTool(
        id=GET_SKILL_CONTENT_ID,
        name=GET_SKILL_CONTENT_ID,
        description=(
            "Load a skill's full instructions by its id. Use this after "
            "search_capabilities surfaces a relevant skill: pull the complete "
            "playbook into your context, then follow it. Returns the skill body "
            "(Markdown); any bundled scripts or files are referenced by absolute "
            "path inside it. When the skill depends on other skills, a `skills` "
            "listing names them so you can load them the same way."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "skillId": {
                    "type": "string",
                    "description": (
                        "id of the skill to load (use search_capabilities to find available ids)"
                    ),
                },
            },
            "required": ["skillId"],
        },
        # `body` on success, `{ error, isError }` when the id is unknown — both
        # valid, so no field is required (an MCP client validates against this).
        output_schema={
            "type": "object",
            "properties": {
                "body": {"type": "string"},
                "skills": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "skillId": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["skillId", "description"],
                    },
                },
                "error": {"type": "string"},
                "isError": {"type": "boolean"},
            },
        },
        execute=execute,
    )
