"""The Jev plugin (ADR-0027, ADR-0028).

Jev (TypeSafe AI) wrapped into the ranking functions a catalog takes,
``retrieve_fn`` and ``reranker_fn``. Search knows only those functions; Jev's
request format lives in the native ranker, so a change to Jev's interface
never reaches the SDK.
"""

from __future__ import annotations

from ratel_ai import RetrieverPlugin

from ._adapter import choice_ranker_plugin, native_ranker

__all__ = ["ratel_jev_plugin"]


def ratel_jev_plugin(
    url: str | None = None,
    api_key_env: str | None = None,
    model: str | None = None,
) -> RetrieverPlugin:
    """Jev as a ranker or reranker (ADR-0027).

    The query and each candidate's searchable text are sent to Jev; every
    failure raises a `RetrieverError` whose ``transient`` flag decides whether a
    reranker falls back to the first stage's order. **Experimental** — may
    change without a major version bump.

    Args:
        url: Jev base URL (a proxy, tests); ``/v1/systemone`` is appended.
            Default ``https://api.typesafe.ai``.
        api_key_env: environment variable holding the Jev key, read at call
            time. Default ``TYPESAFE_API_KEY``.
        model: Jev model. Default ``"jev-latest"``.

    Example::

        jev = ratel_jev_plugin()
        ToolCatalog(method="custom", retrieve_fn=jev.retrieve)   # Jev ranks every tool
        ToolCatalog(method="bm25", reranker_fn=jev.rerank)       # Jev reranks BM25's top 50
    """
    return choice_ranker_plugin(native_ranker("jev", url, api_key_env, model))
