"""Pure-Python client for Ratel Cloud telemetry (ADR-0013)."""

from __future__ import annotations

from .client import RatelCloud
from .events import (
    AssistantMessage,
    Block,
    Content,
    Event,
    EventInput,
    FileBlock,
    FinishReason,
    ImageBlock,
    Message,
    Params,
    TextBlock,
    ToolCallBlock,
    ToolDef,
    ToolMessage,
    Usage,
    UserMessage,
)
from .transport import MAX_BATCH, SendResult, send_batch
from .validate import Issue, ValidationResult, validate

__all__ = [
    "MAX_BATCH",
    "AssistantMessage",
    "Block",
    "Content",
    "Event",
    "EventInput",
    "FileBlock",
    "FinishReason",
    "ImageBlock",
    "Issue",
    "Message",
    "Params",
    "RatelCloud",
    "SendResult",
    "TextBlock",
    "ToolCallBlock",
    "ToolDef",
    "ToolMessage",
    "Usage",
    "UserMessage",
    "ValidationResult",
    "send_batch",
    "validate",
]
