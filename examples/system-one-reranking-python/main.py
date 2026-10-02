"""System-one ranking with Jev, called directly (ADR-0026), end to end.

    uv run main.py

1. BM25 alone is confidently wrong for a "charged twice" question.
2. BM25 retrieves, Jev reranks its candidates.
3. Jev ranks the whole catalog on its own.
4. What failure looks like: a reranker falls back, a standalone search raises.

With TYPESAFE_API_KEY set it calls Jev; without it, a local stand-in that speaks
Jev's wire format. For a catalog Ratel Cloud owns, see
``examples/cloud-tool-picker-python`` instead. The TypeScript mirror is
``examples/system-one-reranking-ts/src/index.ts``.
"""

from __future__ import annotations

import asyncio
import os

from ratel_ai import SystemOneConfig, SystemOneError, ToolCatalog

from local_jev import LocalJev
from tools import QUERY, TOOLS, ids


async def main() -> None:
    local = None if os.environ.get("TYPESAFE_API_KEY") else LocalJev()
    if local is not None:
        os.environ["TYPESAFE_API_KEY"] = "local-stand-in-key"
    system_one: SystemOneConfig = {"url": local.url} if local is not None else {}
    print(f"jev: {f'{local.url}  (local stand-in)' if local else 'https://api.typesafe.ai'}\n")
    print(f'query: "{QUERY}"\n')

    try:
        # 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
        bm25 = ToolCatalog()
        await bm25.register(TOOLS)
        print(f"bm25               : {ids(bm25.search(QUERY, 3))}")
        deep = [h.tool_id for h in bm25.search(QUERY, 20)]
        print(f"  (bm25 ranks stripe_refund_payment #{deep.index('stripe_refund_payment') + 1})")

        # 2. Two stages: BM25 picks up to `depth` candidates, Jev reorders them.
        #    The reranker never adds a tool BM25 did not return.
        reranked = ToolCatalog(
            method="bm25", reranker={"method": "systemOne", "depth": 20}, system_one=system_one
        )
        await reranked.register(TOOLS)
        print(f"bm25 -> systemOne  : {ids(await reranked.search_async(QUERY, 3))}")

        #    Per call, the catalog's reranker can be switched off (or replaced).
        off = await reranked.search_async(QUERY, 3, reranker=False)
        print(f"  reranker=False   : {ids(off)}")

        # 3. One stage: Jev ranks every tool (a tournament above 150).
        standalone = ToolCatalog(method="systemOne", system_one=system_one)
        await standalone.register(TOOLS)
        print(f"systemOne alone    : {ids(await standalone.search_async(QUERY, 3))}")

        # 4. Failure. Point both catalogs at a Jev that is not there.
        down: SystemOneConfig = {"url": "http://127.0.0.1:9"}
        fallback = ToolCatalog(reranker={"method": "systemOne"}, system_one=down)
        await fallback.register(TOOLS)
        print("\njev down:")
        hits = await fallback.search_async(QUERY, 3)
        print(f"  as a reranker    : {ids(hits)}   (BM25 order)")

        strict = ToolCatalog(method="systemOne", system_one=down)
        await strict.register(TOOLS)
        try:
            await strict.search_async(QUERY, 3)
        except SystemOneError as error:
            print(f"  standalone       : SystemOneError code={error.code}")
    finally:
        if local is not None:
            local.close()


if __name__ == "__main__":
    asyncio.run(main())
