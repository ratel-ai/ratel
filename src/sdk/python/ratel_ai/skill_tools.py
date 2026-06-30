"""Skill content tool — the Python mirror of `src/sdk/ts/src/skill-tools.ts`.

`get_skill_content_tool` is the counterpart to `invoke_tool`: the agent discovers
a skill in the `skills` bucket of `search_capabilities`, then loads its full
playbook into context here. The tool description and schemas are a product
contract shown to the model — kept verbatim with the TS SDK.
"""

from __future__ import annotations

from typing import Any

from .catalog import ExecutableTool
from .skill_catalog import SkillCatalog

GET_SKILL_CONTENT_ID = "get_skill_content"

__all__ = ["GET_SKILL_CONTENT_ID", "get_skill_content_tool"]


def get_skill_content_tool(catalog: SkillCatalog) -> ExecutableTool:
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
        return {"body": catalog.invoke(skill_id)}

    return ExecutableTool(
        id=GET_SKILL_CONTENT_ID,
        name=GET_SKILL_CONTENT_ID,
        description=(
            "Load a skill's full instructions by its id. Use this after "
            "search_capabilities surfaces a relevant skill: pull the complete "
            "playbook into your context, then follow it. Returns the skill body "
            "(Markdown); any bundled scripts or files are referenced by absolute "
            "path inside it."
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
                "error": {"type": "string"},
                "isError": {"type": "boolean"},
            },
        },
        execute=execute,
    )
