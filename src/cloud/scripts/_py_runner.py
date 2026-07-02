"""Python side of the cloud e2e check — driven by e2e.mjs.

Records the shared fixtures through RatelCloud (valid enqueued, invalid dropped),
then exercises the raw send_event_batch transport for a concrete accept result, and
prints a one-line JSON summary the orchestrator parses.

argv: <client_endpoint> <batch_endpoint> <api_key> <fixtures_dir>
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from ratel_ai_cloud import RatelCloud, send_event_batch


def _load(kind: Path) -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(kind.glob("*.json"))]


def _unique_event(tag: str) -> dict:
    # A real ingest endpoint deduplicates (accepted = newly ingested count), so a
    # fresh nonce proves genuine ingestion (accepted: 1) rather than a re-send.
    return {
        "provider": "openai",
        "model": "gpt-5.5",
        "ts": datetime.now(timezone.utc).isoformat(),
        "stream": False,
        "messages": [{"role": "user", "content": f"ratel-e2e {tag} {uuid.uuid4()}"}],
    }


async def main() -> None:
    client_endpoint, batch_endpoint, api_key, fixtures_dir = sys.argv[1:5]
    fixtures = Path(fixtures_dir)
    valid = _load(fixtures / "valid")
    invalid = _load(fixtures / "invalid")

    drops: list[str] = []

    def on_error(err: Exception) -> None:
        drops.append(str(err))

    # (a) client behaviour: valid enqueued, invalid dropped, small batch → split.
    async with RatelCloud(
        endpoint=client_endpoint,
        api_key=api_key,
        batch_size=2,
        flush_interval=0.0,
        on_error=on_error,
    ) as cloud:
        for ev in valid:
            cloud.send_event(ev)
        for ev in invalid:
            cloud.send_event(ev)

    validation_drops = sum(1 for m in drops if "dropped invalid event" in m)

    # (b) wire acceptance via the raw transport.
    # Default retries so a cold backend route (transient 5xx) is absorbed.
    result = await send_event_batch(valid, endpoint=batch_endpoint, api_key=api_key)

    # (c) genuine ingestion: a fresh, never-sent event must be newly ingested.
    probe = await send_event_batch([_unique_event("py")], endpoint=batch_endpoint, api_key=api_key)

    print(
        json.dumps(
            {
                "recorded_valid": len(valid),
                "invalid_supplied": len(invalid),
                "drops": validation_drops,
                "batch_ok": result.ok,
                "batch_status": result.status,
                "probe_ok": probe.ok,
                "probe_accepted": probe.accepted,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
