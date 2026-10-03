"""Jev as a retriever and a reranker through the SDK's ranking-function hooks
(ADR-0027), end to end.

    uv run main.py

1. BM25 alone is confidently wrong for a "charged twice" question.
2. BM25 retrieves, Jev reranks its candidates (``reranker_fn``).
3. Jev ranks the whole catalog on its own (``method="custom"``, ``retrieve_fn``).
4. Any ranking function works: a plain one you write yourself.
5. What failure looks like: a reranker falls back, a retriever raises.

With TYPESAFE_API_KEY set it calls Jev; without it, a local stand-in that speaks
Jev's wire format. The TypeScript mirror is
``examples/jev-retriever-ts/src/index.ts``.
"""

from __future__ import annotations

import asyncio
import os

from ratel_ai import RankCandidate, RankedId, RetrieverError, ToolCatalog, ratel_jev_plugin

from local_jev import LocalJev
from tools import QUERY, TOOLS, ids


def refunds_first(query: str, candidates: list[RankCandidate], _top_k: int) -> list[RankedId]:
    """A keyword rule you could swap for any model you call yourself."""
    wants_refund = "money back" in query or "refund" in query
    return [
        {"id": c.id, "score": 1.0 if wants_refund and "Return funds" in c.text else 0.0}
        for c in candidates
    ]


async def main() -> None:
    local = None if os.environ.get("TYPESAFE_API_KEY") else LocalJev()
    if local is not None:
        os.environ["TYPESAFE_API_KEY"] = "local-stand-in-key"
    jev = ratel_jev_plugin(url=local.url if local is not None else None)
    print(f"jev: {f'{local.url}  (local stand-in)' if local else 'https://api.typesafe.ai'}\n")
    print(f'query: "{QUERY}"\n')

    try:
        # 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
        bm25 = ToolCatalog()
        await bm25.register(TOOLS)
        print(f"bm25                : {ids(bm25.search(QUERY, 3))}")
        deep = [h.tool_id for h in bm25.search(QUERY, 20)]
        print(f"  (bm25 ranks stripe_refund_payment #{deep.index('stripe_refund_payment') + 1})")

        # 2. Two stages: BM25 picks up to `reranker_depth` candidates, Jev
        #    reorders them. A reranker never adds a tool BM25 did not return.
        reranked = ToolCatalog(method="bm25", reranker_fn=jev.rerank, reranker_depth=20)
        await reranked.register(TOOLS)
        print(f"bm25 -> jev         : {ids(await reranked.search_async(QUERY, 3))}")

        #    Per call, the catalog's reranker can be switched off.
        off = await reranked.search_async(QUERY, 3, reranker=False)
        print(f"  reranker=False    : {ids(off)}")

        # 3. One stage: Jev ranks every tool (a tournament above 150).
        standalone = ToolCatalog(method="custom", retrieve_fn=jev.retrieve)
        await standalone.register(TOOLS)
        print(f"jev alone           : {ids(await standalone.search_async(QUERY, 3))}")

        # 4. The hooks take any function, sync or async.
        custom = ToolCatalog(reranker_fn=refunds_first)
        await custom.register(TOOLS)
        print(f"bm25 -> your fn     : {ids(await custom.search_async(QUERY, 3))}")

        # 5. Failure. Point the plugin at a Jev that is not there.
        down = ratel_jev_plugin(url="http://127.0.0.1:9")
        fallback = ToolCatalog(reranker_fn=down.rerank)
        await fallback.register(TOOLS)
        print("\njev down:")
        hits = await fallback.search_async(QUERY, 3)
        print(f"  as a reranker     : {ids(hits)}   (BM25 order)")

        strict = ToolCatalog(method="custom", retrieve_fn=down.retrieve)
        await strict.register(TOOLS)
        try:
            await strict.search_async(QUERY, 3)
        except RetrieverError as error:
            print(
                f"  as the retriever  : RetrieverError code={error.code} "
                f"transient={error.transient}"
            )
    finally:
        if local is not None:
            local.close()


if __name__ == "__main__":
    asyncio.run(main())
