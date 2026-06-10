"""Entry point — the Python mirror of `examples/ai-sdk/src/index.ts`.

Run it:

    export OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY, etc.
    uv run main.py "read the files and find every TODO comment under src/"

Without an API key it runs in diagnostic mode: it prints the BM25 top-K that
Ratel would inject, without calling a model.
"""

from __future__ import annotations

import asyncio
import os
import sys

from tools import build_catalog
from tools import TOOLS

# A Pydantic AI model id; override with RATEL_EXAMPLE_MODEL.
DEFAULT_MODEL = "openai:gpt-5-mini"


def main() -> None:
    prompt = " ".join(sys.argv[1:]) or "read the files and find every TODO comment under src/"
    model = os.environ.get("RATEL_EXAMPLE_MODEL", DEFAULT_MODEL)
    catalog = build_catalog()

    print(f'prompt: "{prompt}"')
    print(f"catalog size: {len(TOOLS)}")

    has_key = any(
        os.environ.get(k)
        for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY")
    )
    if not has_key:
        hits = catalog.search(prompt, 3)
        print("\n(diagnostic mode — no model API key set, skipping the model call)")
        ids = ", ".join(h.tool_id for h in hits) or "(none)"
        print(f"initial top-3 (Ratel BM25): {ids}")
        print("always-present: search_tools, invoke_tool")
        return

    print(f"model: {model}\n")
    from agent import run_agent

    result = asyncio.run(run_agent(prompt=prompt, model=model, catalog=catalog))
    print("\nmodel output:")
    print(result.text or "(no final text — agent stopped after tool execution)")


if __name__ == "__main__":
    main()
