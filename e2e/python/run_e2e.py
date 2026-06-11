#!/usr/bin/env python3
"""End-to-end check for the installed `ratel-ai` wheel.

Assumes `ratel-ai` is already pip-installed (from the wheel built on this PR) into
the active environment. Loads the shared fixture catalog, drives the full product
surface through the PUBLIC API, and asserts behavior against e2e/scenario.json:

  1. ToolCatalog.search  — BM25 ranking (top-1 per query)
  2. ToolCatalog.invoke  — executor dispatch
  3. search_tools_tool   — gateway search surface (grouped hits)
  4. invoke_tool_tool    — gateway invoke surface

Exits non-zero on any mismatch. The same assertions run from the TS runner, so a
cross-SDK divergence makes exactly one side fail.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from ratel_ai import (
    ExecutableTool,
    ToolCatalog,
    invoke_tool_tool,
    search_tools_tool,
)

E2E_DIR = Path(__file__).resolve().parent.parent
CATALOG = json.loads((E2E_DIR / "fixtures" / "catalog.json").read_text())
SCENARIO = json.loads((E2E_DIR / "scenario.json").read_text())


def _echo_executor(tool_id: str):
    # default-arg binds tool_id per iteration (avoids late-binding closure bug)
    def run(args: dict[str, Any], _tid: str = tool_id) -> dict[str, Any]:
        return {"tool": _tid, "echo": args}

    return run


def build_catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    for tool in CATALOG["tools"]:
        catalog.register(
            ExecutableTool(
                id=tool["id"],
                name=tool["name"],
                description=tool["description"],
                input_schema=tool.get("inputSchema", {}),
                output_schema=tool.get("outputSchema", {}),
                execute=_echo_executor(tool["id"]),
            )
        )
    return catalog


def fail(msg: str) -> None:
    print(f"FAIL (python): {msg}", file=sys.stderr)
    sys.exit(1)


async def main() -> None:
    catalog = build_catalog()
    n_tools = len(CATALOG["tools"])

    # 1. Search ranking parity.
    for case in SCENARIO["searches"]:
        query, top_k, want = case["query"], case["topK"], case["expectTop1"]
        hits = catalog.search(query, top_k)
        if not hits:
            fail(f"search returned no hits for {query!r}")
        if len(hits) > top_k:
            fail(f"search returned {len(hits)} hits > topK={top_k} for {query!r}")
        if hits[0].tool_id != want:
            fail(
                f"top-1 for {query!r} was {hits[0].tool_id!r} (score {hits[0].score}), "
                f"expected {want!r}"
            )
        scores = [h.score for h in hits]
        if scores != sorted(scores, reverse=True):
            fail(f"scores not descending for {query!r}: {scores}")
        print(f"  search OK: {query!r} -> {hits[0].tool_id} ({hits[0].score:.4f})")

    # 2. Direct invoke.
    inv = SCENARIO["invoke"]
    result = await catalog.invoke(inv["toolId"], inv["args"])
    expected = {"tool": inv["toolId"], "echo": inv["args"]}
    if result != expected:
        fail(f"invoke returned {result!r}, expected {expected!r}")
    print(f"  invoke OK: {inv['toolId']} -> {result}")

    # 3. Gateway search surface.
    gs = SCENARIO["gatewaySearch"]
    search_tool = search_tools_tool(catalog)
    gs_out = await search_tool.execute({"query": gs["query"], "topK": gs["topK"]})
    tool_ids = [h["toolId"] for g in gs_out.get("groups", []) for h in g.get("hits", [])]
    if gs["expectToolId"] not in tool_ids:
        fail(f"gateway search missing {gs['expectToolId']!r}; got {tool_ids}")
    print(f"  gateway search OK: {gs['query']!r} -> {tool_ids}")

    # 4. Gateway invoke surface.
    gi = SCENARIO["gatewayInvoke"]
    invoke_tool = invoke_tool_tool(catalog)
    gi_out = await invoke_tool.execute({"toolId": gi["toolId"], "args": gi["args"]})
    gi_expected = {"tool": gi["toolId"], "echo": gi["args"]}
    if gi_out != gi_expected:
        fail(f"gateway invoke returned {gi_out!r}, expected {gi_expected!r}")
    print(f"  gateway invoke OK: {gi['toolId']} -> {gi_out}")

    print(f"PASS (python): {n_tools} tools, {len(SCENARIO['searches'])} search cases, gateway OK")


if __name__ == "__main__":
    asyncio.run(main())
