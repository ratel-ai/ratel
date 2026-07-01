"""Mirror of the canonical ``ratel-ai-cloud`` Rust schema (ADR-0013).

Events are plain dicts (``TypedDict``), so they serialize to JSON with no
conversion and load straight from the shared conformance fixtures. Kept honest
against the Rust spec by those fixtures.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union


class TextBlock(TypedDict):
    type: Literal["text"]
    text: str


class ToolCallBlock(TypedDict):
    type: Literal["tool_call"]
    id: str
    name: str
    # A parsed object, never a JSON-encoded string.
    arguments: dict[str, Any]


class _MediaRequired(TypedDict):
    media_type: str


class ImageBlock(_MediaRequired, total=False):
    type: Literal["image"]
    # Exactly one of `source` (inline, e.g. base64) or `url`.
    source: str
    url: str


class FileBlock(_MediaRequired, total=False):
    type: Literal["file"]
    source: str
    url: str


Block = Union[TextBlock, ToolCallBlock, ImageBlock, FileBlock]

# Message content: a bare string or an ordered list of typed blocks.
Content = Union[str, "list[Block]"]


class UserMessage(TypedDict):
    role: Literal["user"]
    content: Content


class AssistantMessage(TypedDict):
    role: Literal["assistant"]
    content: Content


class ToolMessage(TypedDict):
    role: Literal["tool"]
    tool_call_id: str
    content: str


Message = Union[UserMessage, AssistantMessage, ToolMessage]


class _ToolDefRequired(TypedDict):
    name: str
    # JSON Schema for the tool's parameters.
    parameters: Any


class ToolDef(_ToolDefRequired, total=False):
    description: str


class Params(TypedDict, total=False):
    temperature: float
    top_p: float
    max_tokens: int
    stop: list[str]


class _UsageRequired(TypedDict):
    input_tokens: int
    output_tokens: int


class Usage(_UsageRequired, total=False):
    # Subset of input_tokens served from cache.
    cached_tokens: int
    # Subset of output_tokens spent on reasoning; not counted on top of them.
    reasoning_tokens: int


FinishReason = Literal["stop", "length", "tool_call", "content_filter", "refusal"]


class _EventRequired(TypedDict):
    provider: str
    model: str
    ts: str
    messages: list[Message]


class Event(_EventRequired, total=False):
    """A single LLM-call event — the entire v1 telemetry surface."""

    stream: bool
    latency_ms: int
    system: str
    tools: list[ToolDef]
    params: Params
    usage: Usage
    finish_reason: FinishReason
