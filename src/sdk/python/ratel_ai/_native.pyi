"""Type stubs for the compiled PyO3 extension (`ratel_ai._native`).

Mirrors `src/sdk/python/native/src/lib.rs` — docstrings here are adapted from
that file's `///` docs, so what an IDE shows matches the runtime `__doc__`. The
native layer is a pure pass-through over `ratel-ai-core`; the ergonomic SDK
surface lives in the pure Python modules of this package.
"""

from typing import Any

class SearchHit:
    """A single search result: the matched tool id and its relevance score."""

    @property
    def tool_id(self) -> str:
        """Id of the matched tool, as passed to `register`."""

    @property
    def score(self) -> float:
        """Relevance score; higher ranks first.

        The scale depends on the search method: raw BM25 (unbounded) for
        "bm25", cosine similarity for "semantic", reciprocal-rank-fusion for
        "hybrid" — scores from different methods are not comparable.
        """

class ToolRegistry:
    """Metadata-only BM25 index over `ratel-ai-core`.

    Executors and the capability-tool / MCP layers live in the pure-Python
    `ratel_ai` package above this binding.
    """

    def __init__(self) -> None: ...
    def register(
        self,
        id: str,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        output_schema: dict[str, Any],
    ) -> None:
        """Register a tool's metadata into the index.

        Replaces in place when `id` is already registered. The schemas must be
        JSON-serializable dicts; anything else raises `ValueError`.
        """

    def search(self, query: str, top_k: int) -> list[SearchHit]:
        """Lexical BM25 search: the top `top_k` tools for `query`, best first.

        Model-free and infallible; the trace event records origin "direct".
        """

    def search_with_origin(self, query: str, top_k: int, origin: str) -> list[SearchHit]:
        """BM25 search tagged with who initiated it.

        `origin` is "agent" (a model calling a capability tool) or anything
        else → "direct" (host code). The origin only labels the emitted trace
        event — ranking is identical to `search`.
        """

    def search_with_method(
        self, query: str, top_k: int, origin: str, method: str
    ) -> list[SearchHit]:
        """Search with an explicit method ("bm25" | "semantic" | "hybrid").

        "bm25" is infallible; "semantic"/"hybrid" rank against the prebuilt
        embedding cache and raise `RuntimeError` (`EmbeddingsNotBuilt`) if it
        isn't built — the model loads at `build_embeddings`, never inside a
        search. An unknown method string raises `ValueError`.
        """

    def build_embeddings(self) -> None:
        """Pre-compute embeddings for not-yet-embedded tools (incremental).

        A later semantic/hybrid search then only embeds the query. Raises
        `RuntimeError` if the model fails to load. The catalog calls this
        after `register` in semantic mode; BM25-only callers never do.
        """

    def record_event(self, event: dict[str, Any]) -> None:
        """Record an SDK-layer trace event into the active sink.

        `event` must be a dict matching one of the core-owned `TraceEvent`
        shapes (ADR-0007, e.g. `{"type": "gateway_search", ...}`); anything
        else raises `ValueError`.
        """

    def set_trace_sink(
        self,
        kind: str,
        session_id: str | None = ...,
        path: str | None = ...,
    ) -> None:
        """Route trace events to a sink.

        `kind` is "noop" (drop everything, the initial state), "memory"
        (buffer for `drain_trace_events`; requires `session_id`) or "jsonl"
        (append to a file; requires `session_id` and `path`). Raises
        `ValueError` on an unknown kind, a missing required argument, or a
        jsonl path that cannot be opened.
        """

    def drain_trace_events(self) -> list[dict[str, Any]]:
        """Drain captured envelopes from the active sink.

        Returns `[]` unless the active sink is "memory".
        """

class SkillHit:
    """A single skill search result: the matched skill id and its relevance score.

    The skill analogue of `SearchHit` (`tool_id` → `skill_id`).
    """

    @property
    def skill_id(self) -> str:
        """Id of the matched skill, as passed to `register`."""

    @property
    def score(self) -> float:
        """Relevance score; higher ranks first.

        Same method-dependent scale as `SearchHit.score`, computed against the
        skill corpus.
        """

class SkillRegistry:
    """Metadata-only BM25 index over the skill corpus (separate from tools).

    The on-demand analogue of `ToolRegistry`: a separate index, so skills are
    ranked independently of tools (own corpus statistics, own top-K).
    """

    def __init__(self) -> None: ...
    def register(
        self,
        id: str,
        name: str,
        description: str,
        tags: list[str],
        tools: list[str],
        skills: list[str],
        metadata: dict[str, list[str]],
        body: str,
    ) -> None:
        """Register a skill's metadata into the index.

        Replaces in place when `id` is already registered. `tags` are indexed
        for ranking; `tools`, `skills` and `metadata` ride along un-indexed for
        higher layers; `body` is the full instruction text, stored for
        on-demand load.
        """

    def search(self, query: str, top_k: int) -> list[SkillHit]:
        """Lexical BM25 search over the skill corpus — see `ToolRegistry.search`."""

    def search_with_origin(self, query: str, top_k: int, origin: str) -> list[SkillHit]:
        """BM25 search tagged with who initiated it — see `ToolRegistry.search_with_origin`."""

    def search_with_method(
        self, query: str, top_k: int, origin: str, method: str
    ) -> list[SkillHit]:
        """Search with an explicit method — see `ToolRegistry.search_with_method`."""

    def build_embeddings(self) -> None:
        """See `ToolRegistry.build_embeddings`."""

    def record_event(self, event: dict[str, Any]) -> None:
        """Record an SDK-layer trace event — see `ToolRegistry.record_event`."""

    def set_trace_sink(
        self,
        kind: str,
        session_id: str | None = ...,
        path: str | None = ...,
    ) -> None:
        """Route trace events to a sink — see `ToolRegistry.set_trace_sink`."""

    def drain_trace_events(self) -> list[dict[str, Any]]:
        """Drain captured envelopes — see `ToolRegistry.drain_trace_events`."""
