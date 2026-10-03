"""Typed embedding and artifact errors, surfaced from the native binding.

``EmbedderError`` subclasses ``RuntimeError`` so existing ``except RuntimeError``
handlers keep working; ``DimensionMismatchError`` subclasses it specifically for
vector-width mismatches. A model-identity mismatch remains an ``EmbedderError``.
Invalid embedding *config* (a bad source combination) is raised as a plain
``ValueError`` at construction.

``ArtifactError`` / ``IncompatibleMergeError`` cover artifact construction
failures; SDK merge composition is internal and there is no public Python merge
API. ``ArtifactWarmError`` covers warm failures and carries ``code`` /
``missing`` attributes set by the native binding.

``RetrieverError`` is raised by, or for, a caller-supplied ranking function
(``retrieve_fn`` / ``reranker_fn``, ADR-0027); the Jev plugin raises it for every
Jev failure.
"""

from __future__ import annotations

from ._native import (
    ArtifactError,
    ArtifactWarmError,
    DimensionMismatchError,
    EmbedderError,
    IncompatibleMergeError,
)


class RetrieverError(RuntimeError):
    """A retrieve or rerank function failed (ADR-0027).

    Raise it from your own ``retrieve_fn`` / ``reranker_fn`` to control what a
    search does with the failure; the Jev plugin (`ratel_jev_plugin`) raises it
    for every Jev failure. As a **reranker**, one with ``transient=True`` does
    not fail the search: it returns the first stage's order and records
    ``rerank_fallback:<code>`` on the trace. Anything else a function raises,
    including a non-transient ``RetrieverError``, fails the search.

    Jev's codes: ``"Config"``, ``"Unauthorized"``, ``"InvalidRequest"`` (not
    transient); ``"RateLimited"``, ``"Overloaded"``, ``"Timeout"``,
    ``"Unreachable"``, ``"Http"``, ``"Malformed"`` (transient).

    Attributes:
        code: stable machine-readable discriminant.
        transient: whether a retry may succeed.
        status: the HTTP status, when the model's service sent one.
        retry_after_secs: seconds the service asked to wait, when it sent
            ``Retry-After``.
    """

    def __init__(
        self,
        message: str,
        code: str,
        *,
        transient: bool = False,
        status: int | None = None,
        retry_after_secs: int | None = None,
    ) -> None:
        """Create the error; ``transient`` defaults to ``False``."""
        super().__init__(message)
        self.code = code
        self.transient = transient
        self.status = status
        self.retry_after_secs = retry_after_secs


__all__ = [
    "ArtifactError",
    "ArtifactWarmError",
    "DimensionMismatchError",
    "EmbedderError",
    "IncompatibleMergeError",
    "RetrieverError",
]
