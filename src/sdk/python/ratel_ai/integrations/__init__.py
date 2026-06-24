"""Provider integrations — drop-in tracing for LLM client SDKs.

Each provider module wraps the client's `create` method so calls auto-emit
generation observations and (opt-in) transparently BM25-prune the `tools` array.
The provider SDKs are optional and imported lazily; prefer the top-level shims
`ratel_ai.openai` / `ratel_ai.anthropic`.
"""

from __future__ import annotations

from .anthropic import wrap_anthropic
from .openai import wrap_openai
from .selection import ToolSelection

__all__ = ["ToolSelection", "wrap_anthropic", "wrap_openai"]
