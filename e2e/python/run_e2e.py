#!/usr/bin/env python3
"""End-to-end check for the installed `ratel-ai` wheel.

Assumes `ratel-ai` is already pip-installed (from the wheel built on this PR) into
the active environment. Loads the shared fixture catalog, drives the full product
surface through the PUBLIC API, and asserts behavior against e2e/scenario.json:

  1. ToolCatalog.search       — BM25 ranking (top-1 per query)
  2. ToolCatalog.invoke       — executor dispatch
  3. search_tools_tool        — gateway search surface (grouped hits)
  4. invoke_tool_tool         — gateway invoke surface
  5. SkillCatalog.search      — BM25 ranking over the skill corpus (top-1 per query)
  6. get_skill_content_tool   — load a skill body by id (+ unknown-id error path)
  7. search_capabilities_tool — unified gateway over tools AND skills (two buckets)
  8. search_capabilities_tool — skill->tool cross-pollination (declared tools, score 0)

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
    Skill,
    SkillCatalog,
    ToolCatalog,
    get_skill_content_tool,
    invoke_tool_tool,
    search_capabilities_tool,
    search_tools_tool,
)

E2E_DIR = Path(__file__).resolve().parent.parent
CATALOG = json.loads((E2E_DIR / "fixtures" / "catalog.json").read_text())
SKILLS = json.loads((E2E_DIR / "fixtures" / "skills.json").read_text())
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


def build_skill_catalog() -> SkillCatalog:
    catalog = SkillCatalog()
    for skill in SKILLS["skills"]:
        catalog.register(
            Skill(
                id=skill["id"],
                name=skill["name"],
                description=skill["description"],
                tags=skill.get("tags", []),
                tools=skill.get("tools", []),
                metadata=skill.get("metadata", {}),
                body=skill.get("body", ""),
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

    # --- Skills surface (0.2.0) ---------------------------------------------
    skill_catalog = build_skill_catalog()
    n_skills = len(SKILLS["skills"])
    skills_by_id = {s["id"]: s for s in SKILLS["skills"]}

    # 5. Skill search ranking parity (separate BM25 corpus from tools).
    for case in SCENARIO["skillSearches"]:
        query, top_k, want = case["query"], case["topK"], case["expectTop1"]
        hits = skill_catalog.search(query, top_k)
        if not hits:
            fail(f"skill search returned no hits for {query!r}")
        if len(hits) > top_k:
            fail(f"skill search returned {len(hits)} hits > topK={top_k} for {query!r}")
        if hits[0].skill_id != want:
            fail(
                f"skill top-1 for {query!r} was {hits[0].skill_id!r} (score {hits[0].score}), "
                f"expected {want!r}"
            )
        scores = [h.score for h in hits]
        if scores != sorted(scores, reverse=True):
            fail(f"skill scores not descending for {query!r}: {scores}")
        print(f"  skill search OK: {query!r} -> {hits[0].skill_id} ({hits[0].score:.4f})")

    # 6. get_skill_content — body round-trip + unknown-id structured error.
    get_skill = get_skill_content_tool(skill_catalog)
    sc = SCENARIO["skillContent"]
    sc_out = await get_skill.execute({"skillId": sc["skillId"]})
    want_body = skills_by_id[sc["skillId"]]["body"]
    if sc_out.get("body") != want_body:
        fail(f"get_skill_content body for {sc['skillId']} was {sc_out.get('body')!r}, expected {want_body!r}")
    print(f"  get_skill_content OK: {sc['skillId']} -> {len(want_body)} bytes")

    unk = SCENARIO["skillContentUnknown"]
    unk_out = await get_skill.execute({"skillId": unk["skillId"]})
    if not unk_out.get("isError"):
        fail(f"get_skill_content for unknown {unk['skillId']!r} should set isError; got {unk_out!r}")
    if "body" in unk_out:
        fail(f"get_skill_content for unknown {unk['skillId']!r} should not return a body; got {unk_out!r}")
    print(f"  get_skill_content unknown-id OK: {unk['skillId']} -> isError")

    # 7. search_capabilities — unified gateway returns tools AND skills buckets.
    cap = SCENARIO["capabilities"]
    search_caps = search_capabilities_tool(catalog, skill_catalog)
    cap_out = await search_caps.execute(
        {"query": cap["query"], "topKTools": cap["topKTools"], "topKSkills": cap["topKSkills"]}
    )
    cap_tool_ids = [h["toolId"] for g in cap_out["tools"]["groups"] for h in g["hits"]]
    cap_skill_ids = [s["skillId"] for s in cap_out["skills"]]
    if cap["expectToolId"] not in cap_tool_ids:
        fail(f"search_capabilities tools bucket missing {cap['expectToolId']!r}; got {cap_tool_ids}")
    if cap["expectSkillId"] not in cap_skill_ids:
        fail(f"search_capabilities skills bucket missing {cap['expectSkillId']!r}; got {cap_skill_ids}")
    print(f"  search_capabilities OK: {cap['query']!r} -> tools={cap_tool_ids} skills={cap_skill_ids}")

    # 8. search_capabilities — skill->tool cross-pollination. A matched skill's
    #    declared tools ride into the tools bucket at score 0, even when the query
    #    doesn't match them. The expected tool shares no terms with the query, so
    #    presence + score 0 proves it arrived via the skill, not a BM25 match.
    xp = SCENARIO["capabilitiesCrossPollination"]
    xp_out = await search_caps.execute(
        {"query": xp["query"], "topKTools": xp["topKTools"], "topKSkills": xp["topKSkills"]}
    )
    xp_skill_ids = [s["skillId"] for s in xp_out["skills"]]
    if xp["expectSkillId"] not in xp_skill_ids:
        fail(f"cross-pollination: skills bucket missing {xp['expectSkillId']!r}; got {xp_skill_ids}")
    xp_hits = {h["toolId"]: h for g in xp_out["tools"]["groups"] for h in g["hits"]}
    want_tool = xp["expectCrossPollinatedToolId"]
    if want_tool not in xp_hits:
        fail(f"cross-pollination: tools bucket missing skill-declared {want_tool!r}; got {list(xp_hits)}")
    if xp_hits[want_tool]["score"] != 0:
        fail(
            f"cross-pollination: {want_tool!r} score was {xp_hits[want_tool]['score']!r}, expected 0 "
            "(non-zero means it matched the query directly, not via the skill)"
        )
    print(f"  cross-pollination OK: {xp['expectSkillId']} -> pulled in {want_tool} (score 0)")

    print(
        f"PASS (python): {n_tools} tools, {len(SCENARIO['searches'])} search cases, "
        f"{n_skills} skills, {len(SCENARIO['skillSearches'])} skill-search cases, "
        "gateway + cross-pollination OK"
    )


if __name__ == "__main__":
    asyncio.run(main())
