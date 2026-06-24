"""Provider integrations — drop-in tracing for LLM client SDKs.

Each provider module wraps the client's `create` method so calls auto-emit
generation observations. The provider SDKs are optional and imported lazily;
prefer the top-level shims `ratel_ai.openai` / `ratel_ai.anthropic`.
"""

from __future__ import annotations

from .anthropic import wrap_anthropic
from .openai import wrap_openai

__all__ = ["wrap_anthropic", "wrap_openai"]
