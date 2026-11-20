"""Agent variant tags (CONVENTIONS.md § ``ratel.variant.*``).

`experimental_with_variant` scopes a run to one variant through OTel baggage plus a typed
context entry. `ExperimentalVariantSpanProcessor` copies the tags onto each span that starts
in that scope. Without OpenTelemetry installed, the helper only validates its input.
"""

from __future__ import annotations

import math
import re
import warnings
from types import TracebackType
from typing import Any, Union

try:
    from opentelemetry import baggage as _baggage
    from opentelemetry import context as _context

    _VARIANT_ATTRIBUTES_KEY: str | None = _context.create_key("ratel.variant.attributes")
except ModuleNotFoundError:  # pragma: no cover - exercised only without OpenTelemetry
    _baggage = None  # type: ignore[assignment]
    _context = None  # type: ignore[assignment]
    _VARIANT_ATTRIBUTES_KEY = None

# Subclass the OTel SDK's SpanProcessor when it is installed, so the processor keeps every
# hook the SDK calls (it adds hooks such as `_on_ending` across releases). A host with the API
# only has no provider to add the processor to.
try:
    from opentelemetry.sdk.trace import SpanProcessor as _SpanProcessorBase
except ModuleNotFoundError:  # pragma: no cover - exercised only without the OTel SDK
    _SpanProcessorBase = object  # type: ignore[assignment,misc]

# The SDK and the telemetry vocabulary ship on separate trains: fall back to the
# CONVENTIONS.md literals when an older ratel-ai-telemetry is installed.
import ratel_ai_telemetry as _vocabulary

RATEL_VARIANT_PREFIX: str = getattr(_vocabulary, "RATEL_VARIANT_PREFIX", "ratel.variant.")
RATEL_VARIANT_EXPERIMENT: str = getattr(
    _vocabulary, "RATEL_VARIANT_EXPERIMENT", "ratel.variant.experiment"
)
RATEL_VARIANT_NAME: str = getattr(_vocabulary, "RATEL_VARIANT_NAME", "ratel.variant.name")
RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN: str = getattr(
    _vocabulary, "RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN", "^[a-z][a-z0-9_]{0,63}$"
)
RATEL_VARIANT_MAX_DESCRIPTORS: int = getattr(_vocabulary, "RATEL_VARIANT_MAX_DESCRIPTORS", 16)
RATEL_VARIANT_MAX_VALUE_LENGTH: int = getattr(_vocabulary, "RATEL_VARIANT_MAX_VALUE_LENGTH", 128)

VariantDescriptorValue = Union[str, int, float, bool]
"""A descriptor value: content-free, and a string, a finite number or a boolean."""

_DESCRIPTOR_KEY = re.compile(RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN)
_RESERVED_KEYS = frozenset({"experiment", "name"})


class _VariantScope:
    """The scope of one variant run: a sync and an async context manager."""

    def __init__(self, attributes: dict[str, VariantDescriptorValue]) -> None:
        self._attributes = attributes
        self._tokens: list[object] = []

    def __enter__(self) -> _VariantScope:
        if _context is None or _baggage is None or _VARIANT_ATTRIBUTES_KEY is None:
            return self
        ctx = _context.get_current()
        for key in list(_baggage.get_all(ctx)):
            if key.startswith(RATEL_VARIANT_PREFIX):
                ctx = _baggage.remove_baggage(key, ctx)
        for key, value in self._attributes.items():
            ctx = _baggage.set_baggage(key, _baggage_value(value), ctx)
        ctx = _context.set_value(_VARIANT_ATTRIBUTES_KEY, dict(self._attributes), ctx)
        self._tokens.append(_context.attach(ctx))
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._tokens and _context is not None:
            _context.detach(self._tokens.pop())  # type: ignore[arg-type]

    async def __aenter__(self) -> _VariantScope:
        return self.__enter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.__exit__(exc_type, exc, tb)


def experimental_with_variant(
    *, experiment: str, name: str, **descriptors: VariantDescriptorValue
) -> _VariantScope:
    """Scope one run of an agent variant: ``with`` (sync) or ``async with`` (async).

    Each span that starts inside the scope (the root span of the run and its descendants,
    also across ``await`` and in tasks created inside) carries ``ratel.variant.experiment``,
    ``ratel.variant.name`` and one ``ratel.variant.<key>`` per descriptor, when the tracer
    provider has `ExperimentalVariantSpanProcessor` (``configure_telemetry`` adds it). The
    tags also go into OTel baggage, so a propagator carries them to other processes.

    An inner scope replaces all tags of an outer scope. An invalid descriptor is dropped with
    a ``UserWarning``; more than 16 descriptors keep the first 16 in key order.

    Experimental: it can change without a major-version bump.

    Args:
        experiment: The experiment the run belongs to (1 to 128 characters).
        name: The variant of that experiment the run uses (1 to 128 characters).
        **descriptors: Content-free settings of the variant, for example ``model`` or
            ``prompt_version``. Each key matches ``^[a-z][a-z0-9_]{0,63}$``.

    Raises:
        ValueError: if ``experiment`` or ``name`` is not a string of 1 to 128 characters.
    """
    _require_bounded_string("experiment", experiment)
    _require_bounded_string("name", name)
    attributes: dict[str, VariantDescriptorValue] = {
        RATEL_VARIANT_EXPERIMENT: experiment,
        RATEL_VARIANT_NAME: name,
    }
    dropped: list[str] = []
    kept = 0
    for key in sorted(descriptors):
        value = descriptors[key]
        if not _is_valid_descriptor(key, value) or kept >= RATEL_VARIANT_MAX_DESCRIPTORS:
            dropped.append(key)
            continue
        attributes[RATEL_VARIANT_PREFIX + key] = value
        kept += 1
    if dropped:
        warnings.warn(
            f"ratel: dropped variant descriptors {', '.join(dropped)}. A descriptor key matches "
            f"{RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN}, a value is a string of 1 to "
            f"{RATEL_VARIANT_MAX_VALUE_LENGTH} characters, a finite number or a boolean, and a "
            f"run has at most {RATEL_VARIANT_MAX_DESCRIPTORS} descriptors.",
            UserWarning,
            stacklevel=2,
        )
    return _VariantScope(attributes)


class ExperimentalVariantSpanProcessor(_SpanProcessorBase):
    """Copy the variant tags of the current scope onto each span at start.

    Add it to the tracer provider beside the exporting processor:
    ``provider.add_span_processor(ExperimentalVariantSpanProcessor())``.
    ``configure_telemetry`` adds it for you.

    Inside `experimental_with_variant` it copies the typed values. Elsewhere it copies
    ``ratel.variant.*`` baggage that came from another process, as strings, when that
    baggage has both an experiment and a name.
    """

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        """Set the variant attributes of ``parent_context`` on ``span``."""
        if _context is None or _VARIANT_ATTRIBUTES_KEY is None:
            return
        attributes = _context.get_value(_VARIANT_ATTRIBUTES_KEY, parent_context)
        if attributes is None:
            attributes = _baggage_attributes(parent_context)
        if attributes:
            span.set_attributes(attributes)

    def on_end(self, span: Any) -> None:
        """Do nothing: the tags are set at start."""

    def shutdown(self) -> None:
        """Do nothing: the processor holds no resources."""

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Do nothing: the processor buffers nothing."""
        return True


def _baggage_attributes(parent_context: Any) -> dict[str, VariantDescriptorValue] | None:
    if _baggage is None:
        return None
    entries = _baggage.get_all(parent_context)
    experiment = entries.get(RATEL_VARIANT_EXPERIMENT)
    name = entries.get(RATEL_VARIANT_NAME)
    if not _is_bounded_string(experiment) or not _is_bounded_string(name):
        return None
    attributes: dict[str, VariantDescriptorValue] = {
        RATEL_VARIANT_EXPERIMENT: experiment,  # type: ignore[dict-item]
        RATEL_VARIANT_NAME: name,  # type: ignore[dict-item]
    }
    kept = 0
    for key in sorted(entries):
        if not key.startswith(RATEL_VARIANT_PREFIX):
            continue
        value = entries[key]
        if not _is_valid_descriptor(key[len(RATEL_VARIANT_PREFIX) :], value):
            continue
        if kept >= RATEL_VARIANT_MAX_DESCRIPTORS:
            break
        attributes[key] = value  # type: ignore[assignment]
        kept += 1
    return attributes


def _baggage_value(value: VariantDescriptorValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _require_bounded_string(field: str, value: object) -> None:
    if not _is_bounded_string(value):
        raise ValueError(
            f"experimental_with_variant: {field} must be a string of 1 to "
            f"{RATEL_VARIANT_MAX_VALUE_LENGTH} characters"
        )


def _is_valid_descriptor(key: str, value: object) -> bool:
    if key in _RESERVED_KEYS or not _DESCRIPTOR_KEY.fullmatch(key):
        return False
    if isinstance(value, str):
        return _is_bounded_string(value)
    if isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    return False


def _is_bounded_string(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= RATEL_VARIANT_MAX_VALUE_LENGTH
