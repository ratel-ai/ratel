"""Type stubs for the compiled PyO3 extension (`ratel_ai._native`).

Mirrors `src/sdk/python/native/src/lib.rs`. The native layer is a pure
pass-through over `ratel-ai-core`; the ergonomic SDK surface lives in the pure
Python modules of this package.
"""

from typing import Any

class SearchHit:
    """A single BM25 search result."""

    @property
    def tool_id(self) -> str: ...
    @property
    def score(self) -> float: ...

class TraceSession:
    """One shared, bounded trace buffer for a whole session (ADR-0013).

    Attach it to every registry so `(session_id, seq)` is unique and there is
    a single drain point for the Cloud exporter.
    """

    def __init__(
        self,
        session_id: str,
        harness: str | None = ...,
        environment: str | None = ...,
        sdk_version: str | None = ...,
        catalog_version: str | None = ...,
        capacity: int | None = ...,
    ) -> None: ...
    def drain(self) -> list[dict[str, Any]]: ...
    def set_catalog_version(self, catalog_version: str | None = ...) -> None: ...
    def dropped_count(self) -> int: ...
    @property
    def session_id(self) -> str: ...

class ToolRegistry:
    """Metadata-only BM25 index over `ratel-ai-core`."""

    def __init__(self) -> None: ...
    def register(
        self,
        id: str,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        output_schema: dict[str, Any],
    ) -> None: ...
    def search(self, query: str, top_k: int) -> list[SearchHit]: ...
    def search_with_origin(self, query: str, top_k: int, origin: str) -> list[SearchHit]: ...
    def search_with_trace(
        self, query: str, top_k: int, origin: str
    ) -> tuple[str, list[SearchHit]]: ...
    def record_event(self, event: dict[str, Any]) -> None: ...
    def set_trace_sink(
        self,
        kind: str,
        session_id: str | None = ...,
        path: str | None = ...,
        harness: str | None = ...,
        environment: str | None = ...,
        sdk_version: str | None = ...,
        catalog_version: str | None = ...,
    ) -> None: ...
    def attach_trace_session(self, session: TraceSession) -> None: ...
    def drain_trace_events(self) -> list[dict[str, Any]]: ...

class SkillHit:
    """A single skill BM25 search result."""

    @property
    def skill_id(self) -> str: ...
    @property
    def score(self) -> float: ...

class SkillRegistry:
    """Metadata-only BM25 index over the skill corpus (separate from tools)."""

    def __init__(self) -> None: ...
    def register(
        self,
        id: str,
        name: str,
        description: str,
        tags: list[str],
        tools: list[str],
        metadata: dict[str, list[str]],
        body: str,
    ) -> None: ...
    def upsert(
        self,
        id: str,
        name: str,
        description: str,
        tags: list[str],
        tools: list[str],
        metadata: dict[str, list[str]],
        body: str,
    ) -> bool: ...
    def remove(self, skill_id: str) -> bool: ...
    def search(self, query: str, top_k: int) -> list[SkillHit]: ...
    def search_with_origin(self, query: str, top_k: int, origin: str) -> list[SkillHit]: ...
    def search_with_trace(
        self, query: str, top_k: int, origin: str
    ) -> tuple[str, list[SkillHit]]: ...
    def record_event(self, event: dict[str, Any]) -> None: ...
    def set_trace_sink(
        self,
        kind: str,
        session_id: str | None = ...,
        path: str | None = ...,
        harness: str | None = ...,
        environment: str | None = ...,
        sdk_version: str | None = ...,
        catalog_version: str | None = ...,
    ) -> None: ...
    def attach_trace_session(self, session: TraceSession) -> None: ...
    def drain_trace_events(self) -> list[dict[str, Any]]: ...
