"""Drop-in OpenAI tracing — `from ratel_ai.openai import OpenAI`.

A traced replacement for `from openai import OpenAI`: construct the client here
and every `chat.completions.create` call is automatically traced (model, prompt,
output, token usage) and shipped to Ratel's cloud. Use `wrap_openai()` to trace
a client you already built.
"""

from __future__ import annotations

from .integrations.openai import AsyncOpenAI, OpenAI, wrap_openai
from .integrations.selection import ToolSelection

__all__ = ["AsyncOpenAI", "OpenAI", "ToolSelection", "wrap_openai"]
