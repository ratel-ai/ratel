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

``CloudError`` covers a failed Ratel Cloud request — a Tool Picker search or a
catalog sync on a ``cloud`` catalog (ADR-0026, ADR-0027) — and carries ``code``
(``"Config"``, ``"Unauthorized"``, ``"InsufficientCredits"``, ``"NoSyncedTools"``,
``"RateLimited"``, ``"TooLarge"``, ``"Timeout"``, ``"Unavailable"``, ``"Http"``,
``"Malformed"``), ``status`` and ``retry_after_secs`` (``None`` when absent).
"""

from __future__ import annotations

from ._native import (
    ArtifactError,
    ArtifactWarmError,
    CloudError,
    DimensionMismatchError,
    EmbedderError,
    IncompatibleMergeError,
)

__all__ = [
    "ArtifactError",
    "ArtifactWarmError",
    "DimensionMismatchError",
    "EmbedderError",
    "IncompatibleMergeError",
    "CloudError",
]
