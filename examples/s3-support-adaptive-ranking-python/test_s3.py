#!/usr/bin/env -S uv run python3
"""Run: RATEL_S3_TEST_BUCKET=my-bucket ./test_s3.py"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from ratel_ai import S3IntentGraphStorage, IntentGraph, StaleIntentGraphError

bucket = os.environ.get("RATEL_S3_TEST_BUCKET")
if not bucket:
    print("set RATEL_S3_TEST_BUCKET (and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)", file=sys.stderr)
    sys.exit(1)

key = os.environ.get("RATEL_S3_TEST_KEY", "ratel/intent-graph-s3-test-v1.json")
region = os.environ.get("RATEL_S3_TEST_REGION", "us-east-1")
endpoint = os.environ.get("RATEL_S3_TEST_ENDPOINT")
_force_path_style_env = os.environ.get("RATEL_S3_TEST_FORCE_PATH_STYLE")
force_path_style = None if _force_path_style_env is None else _force_path_style_env != "false"


def graph(rev: int) -> IntentGraph:
    return IntentGraph.from_json(
        json.dumps({"v": 1, "built_from_ts": int(time.time() * 1000), "rev": rev, "intents": []})
    )


def storage() -> S3IntentGraphStorage:
    return S3IntentGraphStorage(
        bucket=bucket,
        key=key,
        region=region,
        endpoint=endpoint,
        force_path_style=force_path_style,
    )


async def main() -> None:
    initial = storage()
    before = await initial.load()
    rev = (before.rev if before else 0) + 1
    await initial.save(graph(rev))

    reloaded = await storage().load()
    assert reloaded is not None, "object should exist after save"
    assert reloaded.rev == rev, "reloaded rev should match what was written"

    skip_check = storage()
    await skip_check.load()
    await skip_check.save(graph(rev))  # save-when-changed: no-op, must not raise

    writer_a = storage()
    writer_b = storage()
    await writer_a.load()
    await writer_b.load()
    await writer_a.save(graph(rev + 1))
    try:
        await writer_b.save(graph(rev + 2))
        raise AssertionError("stale writer should raise StaleIntentGraphError")
    except StaleIntentGraphError:
        pass

    final = await storage().load()
    assert final is not None and final.rev == rev + 1, "stale writer's save must not have landed"

    print(f"PASS (s3-support-adaptive-ranking-python): s3://{bucket}/{key}, rev={final.rev}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as err:  # noqa: BLE001
        print(f"FAIL (s3-support-adaptive-ranking-python): {err}", file=sys.stderr)
        sys.exit(1)
