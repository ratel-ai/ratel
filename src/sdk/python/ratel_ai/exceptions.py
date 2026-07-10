"""Typed embedding errors, surfaced from the native binding.

``EmbedderError`` subclasses ``RuntimeError`` so existing ``except RuntimeError``
handlers keep working; ``DimensionMismatchError`` subclasses it for the specific
"model changed under an existing embedding set" case. Invalid embedding *config*
(a bad source combination) is raised as a plain ``ValueError`` at construction.
"""

from __future__ import annotations

from ._native import DimensionMismatchError, EmbedderError

__all__ = ["DimensionMismatchError", "EmbedderError"]
