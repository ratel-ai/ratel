"""OpenAI's Decisions API as a retriever and a reranker through the SDK's
ranking-function hooks (ADR-0027), end to end.

    uv run main.py

1. BM25 alone is confidently wrong for a "charged twice" question.
2. BM25 retrieves, Decisions reranks its candidates (``reranker_fn``).
3. Decisions ranks the whole catalog on its own (``method="custom"``, ``retrieve_fn``).
4. What failure looks like: a reranker falls back, a retriever raises.

Making the first plugin emits a one-time beta warning. With OPENAI_API_KEY set
it calls OpenAI; without it, a local stand-in that speaks the Decisions wire
format. The TypeScript mirror is ``examples/openai-decision-retriever-ts/src/index.ts``.
"""

from __future__ import annotations

import asyncio
import os

from ratel_ai import RetrieverError, ToolCatalog, ratel_openai_decision_plugin

from local_openai_decision import LocalDecisions
from tools import QUERY, TOOLS, ids


async def main() -> None:
    local = None if os.environ.get("OPENAI_API_KEY") else LocalDecisions()
    if local is not None:
        os.environ["OPENAI_API_KEY"] = "local-stand-in-key"
    decision = ratel_openai_decision_plugin(url=local.url if local is not None else None)
    where = f"{local.url}  (local stand-in)" if local else "https://api.openai.com"
    print(f"\ndecisions: {where}\n")
    print(f'query: "{QUERY}"\n')

    try:
        # 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
        bm25 = ToolCatalog()
        await bm25.register(TOOLS)
        print(f"bm25                : {ids(bm25.search(QUERY, 3))}")
        deep = [h.tool_id for h in bm25.search(QUERY, 20)]
        print(f"  (bm25 ranks stripe_refund_payment #{deep.index('stripe_refund_payment') + 1})")

        # 2. Two stages: BM25 picks up to `reranker_depth` candidates,
        #    Decisions reorders them. A reranker never adds a tool BM25 did not return.
        reranked = ToolCatalog(method="bm25", reranker_fn=decision.rerank, reranker_depth=20)
        await reranked.register(TOOLS)
        print(f"bm25 -> decisions   : {ids(await reranked.search_async(QUERY, 3))}")

        # 3. One stage: Decisions ranks every tool (a tournament above 150).
        standalone = ToolCatalog(method="custom", retrieve_fn=decision.retrieve)
        await standalone.register(TOOLS)
        print(f"decisions alone     : {ids(await standalone.search_async(QUERY, 3))}")

        # 4. Failure. Point the plugin at an endpoint that is not there.
        down = ratel_openai_decision_plugin(url="http://127.0.0.1:9")
        fallback = ToolCatalog(reranker_fn=down.rerank)
        await fallback.register(TOOLS)
        print("\ndecisions down:")
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
