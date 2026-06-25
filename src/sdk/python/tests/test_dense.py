"""Tests for dense (semantic) retrieval via `ToolCatalog.search_dense`.

Exercises the bundled Candle embedder that ships in dense-enabled wheels
(the published build); see ADR-0013.
"""

from ratel_ai import ExecutableTool, ToolCatalog


def _tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id,
        name=tool_id,
        description=description,
        input_schema={},
        output_schema={},
        execute=lambda args: None,
    )


def _catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    catalog.register(_tool("delete_path", "erase a directory entry permanently"))
    catalog.register(_tool("weather", "get the current weather forecast for a city"))
    catalog.register(_tool("send_email", "compose and send an email message"))
    return catalog


def test_search_dense_surfaces_a_synonym_match() -> None:
    # "remove a file" shares no content words with "erase a directory entry" —
    # the lexical "missing gold" case. Dense should still rank delete_path first.
    hits = _catalog().search_dense("remove a file", 3)
    assert hits[0].tool_id == "delete_path"


def test_search_dense_respects_top_k() -> None:
    hits = _catalog().search_dense("anything", 2)
    assert len(hits) <= 2
