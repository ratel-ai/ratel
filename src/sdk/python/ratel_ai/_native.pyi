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
    # Present only in dense-enabled builds (the published wheels); see ADR-0013.
    def search_dense(self, query: str, top_k: int, origin: str = ...) -> list[SearchHit]: ...
    def record_event(self, event: dict[str, Any]) -> None: ...
    def set_trace_sink(
        self,
        kind: str,
        session_id: str | None = ...,
        path: str | None = ...,
    ) -> None: ...
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
    def search(self, query: str, top_k: int) -> list[SkillHit]: ...
    def search_with_origin(self, query: str, top_k: int, origin: str) -> list[SkillHit]: ...
    # Present only in dense-enabled builds (the published wheels); see ADR-0013.
    def search_dense(self, query: str, top_k: int, origin: str = ...) -> list[SkillHit]: ...
    def record_event(self, event: dict[str, Any]) -> None: ...
    def set_trace_sink(
        self,
        kind: str,
        session_id: str | None = ...,
        path: str | None = ...,
    ) -> None: ...
    def drain_trace_events(self) -> list[dict[str, Any]]: ...
