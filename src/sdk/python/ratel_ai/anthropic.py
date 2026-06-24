"""Drop-in Anthropic tracing — `from ratel_ai.anthropic import Anthropic`.

A traced replacement for `from anthropic import Anthropic`: construct the client
here and every `messages.create` call is automatically traced (model, prompt,
output, token usage) and shipped to Ratel's cloud. Use `wrap_anthropic()` to
trace a client you already built.
"""

from __future__ import annotations

from .integrations.anthropic import Anthropic, AsyncAnthropic, wrap_anthropic
from .integrations.selection import ToolSelection

__all__ = ["Anthropic", "AsyncAnthropic", "ToolSelection", "wrap_anthropic"]
