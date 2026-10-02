"""The Ratel Cloud Tool Picker (ADR-0027) on a cloud-owned catalog (ADR-0028).

    uv run main.py

1. Local BM25 is confidently wrong for a "charged twice" question.
2. ``cloud=`` on the catalog: ``register`` syncs the catalog to Cloud.
3. ``search_async`` ranks through the Tool Picker, in each mode.
4. What failure looks like: a sync that only warns, a search that raises.

With no env vars it runs against a local stand-in for Cloud (no key needed).
Set RATEL_CLOUD_URL=https://cloud.ratel.sh and RATEL_API_KEY to use Cloud. The
TypeScript mirror is ``examples/cloud-tool-picker-ts/src/index.ts``.
"""

from __future__ import annotations

import asyncio
import os
import warnings

from ratel_ai import CloudError, ToolCatalog

from local_cloud import LocalCloud
from tools import QUERY, TOOLS, ids


async def main() -> None:
    real_url = os.environ.get("RATEL_CLOUD_URL")
    local = None if real_url else LocalCloud()
    if local is not None:
        os.environ.setdefault("RATEL_API_KEY", "local-stand-in-key")
    url = real_url or (local.url if local is not None else "")
    print(f"ratel cloud: {url}{'  (local stand-in)' if local else ''}\n")
    print(f'query: "{QUERY}"\n')

    try:
        # 1. Baseline: a local BM25 catalog. "charged" pulls the charge tools up.
        bm25 = ToolCatalog()
        await bm25.register(TOOLS)
        print(f"local bm25        : {ids(bm25.search(QUERY, 3))}")

        # 2. A cloud-owned catalog. register() returns once Cloud has the
        #    catalog; executors stay here, only definitions are uploaded.
        catalog = ToolCatalog(
            cloud={"url": url, "mode": "precise", "source_id": "cloud-tool-picker-example"}
        )
        await catalog.register(TOOLS)
        again = await catalog.sync_now()
        print(f"synced            : {again.tools} tools, version {again.catalog_version}")
        print(f"  re-sync         : skipped={again.skipped} (nothing changed)\n")

        # 3. Every search goes to the Tool Picker; the mode trades speed for accuracy.
        print(f"cloud precise     : {ids(await catalog.search_async(QUERY, 3))}")
        for mode in ("instant", "exhaustive"):
            hits = await catalog.search_async(QUERY, 3, mode=mode)  # type: ignore[arg-type]
            print(f"cloud {mode:<11} : {ids(hits)}")

        # 4. Failure. A catalog pointed at a Cloud that is not there.
        down = ToolCatalog(cloud={"url": "http://127.0.0.1:9", "on_sync_error": "warn"})
        print("\ncloud down:")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            await down.register(TOOLS)  # warns; the tools stay registered locally
        print(f"  register        : warned ({caught[0].category.__name__})")
        try:
            await down.search_async(QUERY, 3)
        except CloudError as error:
            print(f"  search          : CloudError code={error.code}")
    finally:
        if local is not None:
            local.close()


if __name__ == "__main__":
    asyncio.run(main())
