"""`RatelClient` — the lean cloud analytics client (ADR-0016).

Records one usage *rollup* per agent interaction and ships it to
`POST {host}/api/v1/events` — the exact shape Ratel's dashboard renders.
Background, batched, best-effort.

Hard rule: nothing here may raise into customer code, and absent an API key the
client is a no-op. The token / savings / cost maths come from `ratel-ai-core`
(native), so this module only assembles and ships.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import random
import threading
from datetime import datetime
from typing import Any

from ._emit import Exporter, NoopExporter
from .config import ObservabilityConfig
from .rollup import SourceMap, build_rollup

logger = logging.getLogger("ratel_ai.observability")


class RatelClient:
    """Builds usage rollups and ships them to Ratel's cloud."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        host: str | None = None,
        enabled: bool | None = None,
        flush_at: int | None = None,
        flush_interval: float | None = None,
        max_queue: int | None = None,
        timeout: float | None = None,
        sample_rate: float | None = None,
        release: str | None = None,
        debug: bool | None = None,
        exporter: Exporter | None = None,
    ) -> None:
        self.config = ObservabilityConfig.resolve(
            api_key=api_key,
            host=host,
            enabled=enabled,
            flush_at=flush_at,
            flush_interval=flush_interval,
            max_queue=max_queue,
            timeout=timeout,
            sample_rate=sample_rate,
            release=release,
            debug=debug,
        )
        if self.config.debug:
            logging.getLogger("ratel_ai.observability").setLevel(logging.DEBUG)
        if self.config.can_export and self.config.host.startswith("http://"):
            logger.warning(
                "ratel: RATEL_HOST uses a non-TLS scheme (http://) — the API key "
                "and analytics payloads will be sent unencrypted"
            )
        self._exporter: Exporter = exporter if exporter is not None else self._build_exporter()
        self._register_atexit()

    # -- construction helpers ------------------------------------------------

    def _build_exporter(self) -> Exporter:
        if not self.config.can_export:
            return NoopExporter()
        try:
            from .exporter import BatchProcessor

            return BatchProcessor(self.config)
        except Exception as exc:  # missing httpx, etc. — degrade, never crash
            logger.warning("ratel: exporter unavailable (%s); running in no-op mode", exc)
            return NoopExporter()

    def _register_atexit(self) -> None:
        with contextlib.suppress(Exception):
            atexit.register(self.flush)

    # -- recording -----------------------------------------------------------

    def track(
        self,
        *,
        tokens_by_category: SourceMap,
        saved_by_category: SourceMap | None = None,
        saveable_by_category: SourceMap | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        model: str | None = None,
        latency_ms: int | None = None,
        cost_usd: float | None = None,
        occurred_at: datetime | str | None = None,
    ) -> None:
        """Record one interaction's usage rollup. Best-effort; never raises.

        `tokens_by_category` is the per-source prompt spend; `saved_by_category`
        is what Ratel selection kept out of the prompt this run, and
        `saveable_by_category` is what it *could* save in observe-only mode.
        """
        try:
            if self.config.sample_rate < 1.0 and random.random() >= self.config.sample_rate:
                return
            rollup = build_rollup(
                tokens_by_category=tokens_by_category,
                saved_by_category=saved_by_category,
                saveable_by_category=saveable_by_category,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                model=model,
                latency_ms=latency_ms,
                cost_usd=cost_usd,
                occurred_at=occurred_at,
            )
            self._exporter.enqueue(rollup)
        except Exception as exc:  # assembling/queuing must never break the caller
            logger.debug("ratel: rollup dropped: %s", exc)

    # -- lifecycle -----------------------------------------------------------

    def flush(self, timeout: float | None = None) -> None:
        with contextlib.suppress(Exception):
            self._exporter.flush(timeout)

    def shutdown(self) -> None:
        with contextlib.suppress(Exception):
            self._exporter.shutdown()


_singleton_lock = threading.Lock()
_singleton: RatelClient | None = None


def get_client() -> RatelClient:
    """Return the process-wide client, creating it from the environment once."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = RatelClient()
    return _singleton


def configure(**kwargs: Any) -> RatelClient:
    """Replace the process-wide client with one built from `kwargs`.

    The previous client is shut down so its background exporter thread and HTTP
    connection don't leak (e.g. when rotating the API key or host mid-process).
    """
    global _singleton
    # Build outside the lock — RatelClient construction can lazily import httpx,
    # and we must not hold the singleton lock across that.
    new_client = RatelClient(**kwargs)
    with _singleton_lock:
        old = _singleton
        _singleton = new_client
    if old is not None:
        old.shutdown()
    return new_client


def set_global_client(client: RatelClient | None) -> None:
    """Install (or clear) the process-wide client. Primarily for tests."""
    global _singleton
    with _singleton_lock:
        _singleton = client
