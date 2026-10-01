"""System-one ranking and the two-stage reranker (ADR-0026), end to end.

    uv run main.py

1. BM25 alone is confidently wrong for a "charged twice" question.
2. BM25 retrieves, a system-one model reranks its candidates.
3. The system-one model ranks the whole catalog on its own.
4. What failure looks like: a reranker falls back, a standalone search raises.

With no env vars it runs against a local stand-in endpoint (no key needed). Set
RATEL_SYSTEM_ONE_URL (and RATEL_API_KEY) to call a real endpoint instead. The
TypeScript mirror is ``examples/system-one-reranking-ts/src/index.ts``.
"""

from __future__ import annotations

import asyncio
import os

from ratel_ai import SystemOneConfig, SystemOneError, ToolCatalog

from mock_system_one import MockSystemOne
from tools import QUERY, TOOLS, ids

KEY_ENV = "RATEL_API_KEY"


async def main() -> None:
    real_url = os.environ.get("RATEL_SYSTEM_ONE_URL")
    mock = None if real_url else MockSystemOne()
    url = real_url or (mock.url if mock is not None else "")
    if mock is not None:
        os.environ.setdefault(KEY_ENV, "local-mock-key")
    system_one: SystemOneConfig = {"url": url, "api_key_env": KEY_ENV}
    print(f"system-one endpoint: {system_one['url']}{'  (local stand-in)' if mock else ''}\n")
    print(f'query: "{QUERY}"\n')

    try:
        # 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
        bm25 = ToolCatalog()
        await bm25.register(TOOLS)
        print(f"bm25               : {ids(bm25.search(QUERY, 3))}")
        deep = [h.tool_id for h in bm25.search(QUERY, 20)]
        print(f"  (bm25 ranks stripe_refund_payment #{deep.index('stripe_refund_payment') + 1})")

        # 2. Two stages: BM25 picks up to `depth` candidates, system-one reorders
        #    them. The reranker never adds a tool BM25 did not return.
        reranked = ToolCatalog(
            method="bm25", reranker={"method": "systemOne", "depth": 20}, system_one=system_one
        )
        await reranked.register(TOOLS)
        print(f"bm25 -> systemOne  : {ids(await reranked.search_async(QUERY, 3))}")

        #    Per call, the catalog's reranker can be switched off (or replaced).
        off = await reranked.search_async(QUERY, 3, reranker=False)
        print(f"  reranker=False   : {ids(off)}")

        # 3. One stage: the system-one model ranks every tool in the catalog.
        standalone = ToolCatalog(method="systemOne", system_one=system_one)
        await standalone.register(TOOLS)
        print(f"systemOne alone    : {ids(await standalone.search_async(QUERY, 3))}")

        # 4. Failure. Point both catalogs at an endpoint that is not there.
        down: SystemOneConfig = {"url": "http://127.0.0.1:9/v1/systemone", "api_key_env": KEY_ENV}
        fallback = ToolCatalog(reranker={"method": "systemOne"}, system_one=down)
        await fallback.register(TOOLS)
        print("\nendpoint down:")
        hits = await fallback.search_async(QUERY, 3)
        print(f"  as a reranker    : {ids(hits)}   (BM25 order)")

        strict = ToolCatalog(method="systemOne", system_one=down)
        await strict.register(TOOLS)
        try:
            await strict.search_async(QUERY, 3)
        except SystemOneError as error:
            print(f"  standalone       : SystemOneError code={error.code}")

        if mock is not None:
            print(f"\nstand-in endpoint served {mock.requests} requests")
    finally:
        if mock is not None:
            mock.close()


if __name__ == "__main__":
    asyncio.run(main())
