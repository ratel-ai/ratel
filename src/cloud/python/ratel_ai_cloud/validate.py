"""Semantic validation — the same invariants the Rust spec's ``validate`` enforces."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .events import Event


@dataclass
class Issue:
    """One validation failure: a JSON-ish ``path`` and a ``message``."""

    path: str
    message: str


@dataclass
class ValidationResult:
    ok: bool
    issues: list[Issue] = field(default_factory=list)


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def validate(event: Event) -> ValidationResult:
    """Check an event's semantic invariants. Structural shape is assumed."""
    issues: list[Issue] = []

    def fail(path: str, message: str) -> None:
        issues.append(Issue(path=path, message=message))

    if not str(event.get("provider", "")).strip():
        fail("provider", "must not be empty")
    if not str(event.get("model", "")).strip():
        fail("model", "must not be empty")
    if not str(event.get("ts", "")).strip():
        fail("ts", "must not be empty")
    if not event.get("messages"):
        fail("messages", "must not be empty")

    for i, tool in enumerate(event.get("tools", [])):
        if not str(tool.get("name", "")).strip():
            fail(f"tools[{i}].name", "must not be empty")
        if not _is_object(tool.get("parameters")):
            fail(f"tools[{i}].parameters", "must be a JSON Schema object")

    for i, message in enumerate(event.get("messages", [])):
        base = f"messages[{i}]"
        role = message.get("role")
        if role == "tool":
            if not str(message.get("tool_call_id", "")).strip():
                fail(f"{base}.tool_call_id", "must not be empty")
            continue
        _validate_content(message.get("content"), role == "assistant", base, fail)

    return ValidationResult(ok=not issues, issues=issues)


def _validate_content(
    content: Any,
    allow_tool_call: bool,
    base: str,
    fail: Callable[[str, str], None],
) -> None:
    if not isinstance(content, list):
        return
    for j, block in enumerate(content):
        path = f"{base}.content[{j}]"
        kind = block.get("type")
        if kind == "tool_call":
            if not allow_tool_call:
                fail(path, "tool_call blocks are only allowed in assistant messages")
            if not _is_object(block.get("arguments")):
                fail(f"{path}.arguments", "must be a parsed object")
        elif kind in ("image", "file"):
            has_source = block.get("source") is not None
            has_url = block.get("url") is not None
            if has_source == has_url:
                fail(path, "exactly one of `source` or `url` must be set")
            if not str(block.get("media_type", "")).strip():
                fail(f"{path}.media_type", "must not be empty")
