"""Semantic + structural validation — the invariants the Rust spec enforces via serde
plus its ``validate``, restated here because Python ``TypedDict``s give no runtime gate,
so the pure-language client must re-check role / block type / finish reason / number
shape itself (that is what the extra checks vs the Rust ``validate`` cover)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .events import Event

# Ingest bounds, mirrored from the cloud consumer (cloud-schema.ts) + the Rust spec.
MAX_INT4 = 2_147_483_647  # Postgres `integer` upper bound
MAX_TEXT = 2_000_000
MAX_BLOB = 20_000_000
MAX_NAME = 1_024
MAX_URL = 8_192
MAX_BLOCKS = 20_000
MAX_MESSAGES = 10_000
MAX_TOOLS = 2_000
MAX_STOP = 100

_ROLES = frozenset({"user", "assistant", "tool"})
_BLOCK_TYPES = frozenset({"text", "tool_call", "image", "file"})
_FINISH_REASONS = frozenset({"stop", "length", "tool_call", "content_filter", "refusal"})
_SOURCE_KEYS = ("skills", "tools", "history", "memory", "user_input")

Fail = Callable[[str, str], None]


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


def _is_token_count(value: Any) -> bool:
    # ``bool`` is a subclass of ``int`` — exclude it so ``True``/``False`` aren't counts.
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_INT4


def _check_name(value: Any, path: str, fail: Fail) -> None:
    """A required identifier: a non-empty string within the name-length bound."""
    if not isinstance(value, str) or not value.strip():
        fail(path, "must not be empty")
    elif len(value) > MAX_NAME:
        fail(path, "exceeds maximum length")


def _check_text(value: Any, maximum: int, path: str, fail: Fail) -> None:
    """A free-text field: must be a string, bounded in length (may be empty)."""
    if not isinstance(value, str):
        fail(path, "must be a string")
    elif len(value) > maximum:
        fail(path, "exceeds maximum length")


def validate(event: Event) -> ValidationResult:
    """Check an event's semantic + structural invariants. Fully defensive: callers reach
    this through ``RatelCloud.send_event``, so malformed input is reported, never raised on."""
    issues: list[Issue] = []

    def fail(path: str, message: str) -> None:
        issues.append(Issue(path=path, message=message))

    ev: dict[str, Any] = dict(event) if isinstance(event, dict) else {}

    _check_name(ev.get("provider"), "provider", fail)
    _check_name(ev.get("model"), "model", fail)
    # `ts` only required non-empty: the consumer tolerates any string and falls back to
    # receipt time, so a strict format check would reject events the endpoint accepts.
    _check_name(ev.get("ts"), "ts", fail)

    raw_messages = ev.get("messages")
    messages = raw_messages if isinstance(raw_messages, list) else []
    if not messages:
        fail("messages", "must not be empty")
    if len(messages) > MAX_MESSAGES:
        fail("messages", "too many messages")

    raw_tools = ev.get("tools")
    tools = raw_tools if isinstance(raw_tools, list) else []
    if len(tools) > MAX_TOOLS:
        fail("tools", "too many tools")
    for i, tool in enumerate(tools):
        if not _is_object(tool):
            fail(f"tools[{i}]", "must be an object")
            continue
        _check_name(tool.get("name"), f"tools[{i}].name", fail)
        if tool.get("description") is not None:
            _check_text(tool.get("description"), MAX_TEXT, f"tools[{i}].description", fail)
        if not _is_object(tool.get("parameters")):
            fail(f"tools[{i}].parameters", "must be a JSON Schema object")

    for i, message in enumerate(messages):
        base = f"messages[{i}]"
        if not _is_object(message):
            fail(base, "must be an object")
            continue
        role = message.get("role")
        if role not in _ROLES:
            fail(f"{base}.role", "must be one of: user, assistant, tool")
            continue
        if role == "tool":
            _check_name(message.get("tool_call_id"), f"{base}.tool_call_id", fail)
            _check_text(message.get("content"), MAX_TEXT, f"{base}.content", fail)
            continue
        _validate_content(message.get("content"), role == "assistant", base, fail)

    finish = ev.get("finish_reason")
    if finish is not None and finish not in _FINISH_REASONS:
        fail("finish_reason", "must be a known finish reason")
    latency = ev.get("latency_ms")
    if latency is not None and (
        isinstance(latency, bool)
        or not isinstance(latency, (int, float))
        or latency < 0
        or latency > MAX_INT4
    ):
        fail("latency_ms", "must be a non-negative number within range")
    _validate_usage(ev.get("usage"), fail)
    _validate_params(ev.get("params"), fail)
    _validate_savings(ev.get("savings"), fail)

    return ValidationResult(ok=not issues, issues=issues)


def _validate_content(content: Any, allow_tool_call: bool, base: str, fail: Fail) -> None:
    if isinstance(content, str):
        _check_text(content, MAX_TEXT, f"{base}.content", fail)
        return
    if not isinstance(content, list):
        fail(f"{base}.content", "must be a string or an array of blocks")
        return
    if not content:
        fail(f"{base}.content", "blocks array must not be empty")
        return
    if len(content) > MAX_BLOCKS:
        fail(f"{base}.content", "too many content blocks")
    for j, block in enumerate(content):
        _validate_block(block, allow_tool_call, f"{base}.content[{j}]", fail)


def _validate_block(block: Any, allow_tool_call: bool, path: str, fail: Fail) -> None:
    if not _is_object(block):
        fail(path, "must be an object")
        return
    kind = block.get("type")
    if kind not in _BLOCK_TYPES:
        fail(path, "unknown block type")
        return
    if kind == "text":
        _check_text(block.get("text"), MAX_TEXT, f"{path}.text", fail)
    elif kind == "tool_call":
        if not allow_tool_call:
            fail(path, "tool_call blocks are only allowed in assistant messages")
        _check_name(block.get("id"), f"{path}.id", fail)
        _check_name(block.get("name"), f"{path}.name", fail)
        if not _is_object(block.get("arguments")):
            fail(f"{path}.arguments", "must be a parsed object")
    else:
        _validate_media(block, path, fail)


def _validate_media(block: dict[str, Any], path: str, fail: Fail) -> None:
    # An explicit ``null`` (some JSON serializers emit it for an absent field) is not a
    # string and not "absent" to the consumer's Zod schema, which rejects it — so we do too.
    if "source" in block and not isinstance(block["source"], str):
        fail(f"{path}.source", "must be a string")
    if "url" in block and not isinstance(block["url"], str):
        fail(f"{path}.url", "must be a string")
    source = block.get("source")
    url = block.get("url")
    has_source = isinstance(source, str)
    has_url = isinstance(url, str)
    if has_source == has_url:
        fail(path, "exactly one of `source` or `url` must be set")
    if isinstance(source, str) and len(source) > MAX_BLOB:
        fail(f"{path}.source", "exceeds maximum length")
    if isinstance(url, str) and len(url) > MAX_URL:
        fail(f"{path}.url", "exceeds maximum length")
    _check_name(block.get("media_type"), f"{path}.media_type", fail)


def _validate_usage(usage: Any, fail: Fail) -> None:
    if usage is None:
        return
    if not _is_object(usage):
        fail("usage", "must be an object")
        return
    if not _is_token_count(usage.get("input_tokens")):
        fail("usage.input_tokens", "must be a non-negative integer within range")
    if not _is_token_count(usage.get("output_tokens")):
        fail("usage.output_tokens", "must be a non-negative integer within range")
    input_tokens = usage.get("input_tokens") if _is_token_count(usage.get("input_tokens")) else 0
    output_tokens = usage.get("output_tokens") if _is_token_count(usage.get("output_tokens")) else 0
    cached = usage.get("cached_tokens")
    if cached is not None:
        if not _is_token_count(cached):
            fail("usage.cached_tokens", "must be a non-negative integer within range")
        elif cached > input_tokens:
            fail("usage.cached_tokens", "must not exceed input_tokens")
    reasoning = usage.get("reasoning_tokens")
    if reasoning is not None:
        if not _is_token_count(reasoning):
            fail("usage.reasoning_tokens", "must be a non-negative integer within range")
        elif reasoning > output_tokens:
            fail("usage.reasoning_tokens", "must not exceed output_tokens")


def _validate_savings(savings: Any, fail: Fail) -> None:
    if savings is None:
        return
    if not _is_object(savings):
        fail("savings", "must be an object")
        return
    _validate_source_tokens(savings.get("tokens_by_category"), "savings.tokens_by_category", fail)
    if savings.get("saved_by_category") is not None:
        _validate_source_tokens(savings.get("saved_by_category"), "savings.saved_by_category", fail)
    if savings.get("saveable_by_category") is not None:
        _validate_source_tokens(
            savings.get("saveable_by_category"), "savings.saveable_by_category", fail
        )


def _validate_source_tokens(src: Any, base: str, fail: Fail) -> None:
    if not _is_object(src):
        fail(base, "must be an object")
        return
    for key in _SOURCE_KEYS:
        value = src.get(key)
        if value is not None and not _is_token_count(value):
            fail(f"{base}.{key}", "must be a non-negative integer within range")


def _validate_params(params: Any, fail: Fail) -> None:
    if params is None:
        return
    if not _is_object(params):
        fail("params", "must be an object")
        return
    stop = params.get("stop")
    if stop is None:
        return
    if not isinstance(stop, list):
        fail("params.stop", "must be an array of strings")
        return
    if len(stop) > MAX_STOP:
        fail("params.stop", "too many stop sequences")
    for i, s in enumerate(stop):
        _check_text(s, MAX_NAME, f"params.stop[{i}]", fail)
