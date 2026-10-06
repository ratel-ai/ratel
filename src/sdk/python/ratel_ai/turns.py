"""Turn scope: mark one user request once, and everything inside it carries its id.

The Python mirror of `src/sdk/ts/src/turn.ts` (ADR-0026). A turn is a
`contextvars` scope, so it follows the request through sync code, `await`, and
the asyncio tasks it creates, while concurrent requests keep their own.
"""

from __future__ import annotations

import contextvars
import json
import threading
import weakref
from collections import OrderedDict
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Any

from .runtime_events import new_runtime_event_id

if TYPE_CHECKING:
    from .catalog import ToolCatalog
    from .telemetry import RuntimeEventProjection

#: Maximum UTF-8 byte size of a `turn_start` event's `user_message`.
TURN_USER_MESSAGE_MAX_BYTES = 4 * 1_024

_STARTED_TURNS_MAX = 4_096
_EXTERNAL_INVOCATIONS_MAX = 4_096


@dataclass(frozen=True)
class _ActiveTurn:
    id: str
    end_user_id: str | None = None


_ACTIVE_TURN: contextvars.ContextVar[_ActiveTurn | None] = contextvars.ContextVar(
    "ratel_ai_turn", default=None
)


def current_turn_id() -> str | None:
    """The id of the turn the caller is running inside, or ``None`` outside any turn.

    Turn scopes nest: the innermost wins.
    """
    turn = _ACTIVE_TURN.get()
    return None if turn is None else turn.id


def active_turn() -> _ActiveTurn | None:
    """The innermost active turn, with its end-user id (internal)."""
    return _ACTIVE_TURN.get()


def with_turn_context(
    projection: RuntimeEventProjection | None,
) -> RuntimeEventProjection | None:
    """Fill the active turn's ids into an event's correlation context (internal).

    An explicit ``turn_id`` already on the projection wins; the scope still
    supplies the end-user id. Returns the input unchanged outside any turn.
    """
    turn = _ACTIVE_TURN.get()
    if turn is None:
        return projection
    filled: dict[str, Any] = dict(projection or {})
    filled.setdefault("turn_id", turn.id)
    if turn.end_user_id is not None:
        filled.setdefault("end_user_id", turn.end_user_id)
    return filled  # type: ignore[return-value]


def truncate_user_message(message: str) -> str:
    """Cap a user message at 4 KiB of UTF-8 without splitting a character (internal)."""
    encoded = message.encode("utf-8")
    if len(encoded) <= TURN_USER_MESSAGE_MAX_BYTES:
        return message
    return encoded[:TURN_USER_MESSAGE_MAX_BYTES].decode("utf-8", errors="ignore")


class _BoundedIds:
    """Thread-safe, insertion-ordered id set that forgets its oldest entries."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._ids: OrderedDict[str, None] = OrderedDict()
        self._lock = threading.Lock()

    def discard(self, value: str) -> None:
        """Forget ``value`` if present."""
        with self._lock:
            self._ids.pop(value, None)

    def add(self, value: str) -> bool:
        """Add ``value``; return whether it was new."""
        with self._lock:
            if value in self._ids:
                return False
            self._ids[value] = None
            if len(self._ids) > self._capacity:
                self._ids.popitem(last=False)
            return True

    def __contains__(self, value: object) -> bool:
        with self._lock:
            return value in self._ids


# A turn starts once per catalog: reopening a known id (a resumed stream, an
# adapter joining the host's turn) must not emit a second `turn_start`.
_started_turns: weakref.WeakKeyDictionary[Any, _BoundedIds] = weakref.WeakKeyDictionary()
_started_turns_lock = threading.Lock()

# Core invocation events carry no `origin`; a tool the host ran itself is marked
# by invocation id and stamped where events leave the SDK (runtime_events.py).
_external_invocations = _BoundedIds(_EXTERNAL_INVOCATIONS_MAX)


def is_external_invocation(invocation_id: object) -> bool:
    """Whether an invocation id was recorded through ``record_tool_call`` (internal)."""
    return isinstance(invocation_id, str) and invocation_id in _external_invocations


def _release_turn_start(catalog: ToolCatalog, turn_id: str) -> None:
    with _started_turns_lock:
        started = _started_turns.get(catalog)
    if started is not None:
        started.discard(turn_id)


def _claim_turn_start(catalog: ToolCatalog, turn_id: str) -> bool:
    with _started_turns_lock:
        started = _started_turns.get(catalog)
        if started is None:
            started = _BoundedIds(_STARTED_TURNS_MAX)
            _started_turns[catalog] = started
    return started.add(turn_id)


class Turn:
    """One turn scope, used as ``with catalog.turn(...):`` or ``async with``.

    Entering sets the turn for the current context and records one
    ``turn_start`` event; exiting restores the outer turn, if any. Build it with
    :meth:`ratel_ai.ToolCatalog.turn`.
    """

    def __init__(
        self,
        catalog: ToolCatalog,
        *,
        id: str | None = None,
        user_message: str | None = None,
        end_user_id: str | None = None,
    ) -> None:
        """Validate the turn's options; nothing is recorded until it is entered."""
        if id is not None and (not isinstance(id, str) or not id):
            raise TypeError("turn id must be a non-empty string")
        if user_message is not None and not isinstance(user_message, str):
            raise TypeError("user_message must be a string")
        if end_user_id is not None and not isinstance(end_user_id, str):
            raise TypeError("end_user_id must be a string")
        self._catalog = catalog
        self._id = id
        self._user_message = user_message
        self._end_user_id = end_user_id
        self._tokens: list[contextvars.Token[_ActiveTurn | None]] = []

    @property
    def id(self) -> str | None:
        """The turn id: the one given, or the one minted on entry (``None`` before)."""
        return self._id

    def __enter__(self) -> Turn:
        """Open the turn in the current context."""
        outer = _ACTIVE_TURN.get()
        if self._id is None:
            self._id = new_runtime_event_id()
        end_user_id = self._end_user_id
        if end_user_id is None and outer is not None:
            end_user_id = outer.end_user_id
        token = _ACTIVE_TURN.set(_ActiveTurn(self._id, end_user_id))
        try:
            self._record_turn_start(self._id)
        except BaseException:
            # The caller's `with` body never runs and `__exit__` is never
            # called, so restore the outer turn here.
            _ACTIVE_TURN.reset(token)
            raise
        self._tokens.append(token)
        return self

    def _record_turn_start(self, turn_id: str) -> None:
        from .telemetry import ambient_projection

        if not _claim_turn_start(self._catalog, turn_id):
            return
        event: dict[str, Any] = {"type": "turn_start"}
        if self._user_message is not None:
            event["user_message"] = truncate_user_message(self._user_message)
        try:
            self._catalog.record_event(event, ambient_projection())
        except BaseException:
            # Release the claim so a retry of the same id still opens the turn.
            _release_turn_start(self._catalog, turn_id)
            raise

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the turn and restore the outer one."""
        _ACTIVE_TURN.reset(self._tokens.pop())

    async def __aenter__(self) -> Turn:
        """Open the turn in the current (task's) context."""
        return self.__enter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the turn and restore the outer one."""
        self.__exit__(exc_type, exc, traceback)


def _error_message(error: object) -> str:
    if isinstance(error, BaseException):
        return str(error) or type(error).__name__
    if isinstance(error, str):
        return error
    try:
        return json.dumps(error)
    except (TypeError, ValueError):
        return str(error)


def record_external_tool_call(
    catalog: ToolCatalog,
    tool_id: str,
    *,
    took_ms: float | None = None,
    error: object = None,
    turn_id: str | None = None,
) -> None:
    """Record a tool the host's framework ran itself as one invocation lifecycle (internal)."""
    from .telemetry import ambient_projection

    if not isinstance(tool_id, str) or not tool_id:
        raise TypeError("record_tool_call() needs a non-empty string tool_id")
    if took_ms is not None and (
        isinstance(took_ms, bool)
        or not isinstance(took_ms, (int, float))
        or took_ms != took_ms
        or took_ms in (float("inf"), float("-inf"))
        or took_ms < 0
    ):
        raise TypeError("took_ms must be a finite, non-negative number of milliseconds")
    if turn_id is not None and (not isinstance(turn_id, str) or not turn_id):
        raise TypeError("turn_id must be a non-empty string")
    invocation_id = new_runtime_event_id()
    _external_invocations.add(invocation_id)
    projection = ambient_projection(invocation_id=invocation_id, turn_id=turn_id)
    elapsed = round(took_ms or 0)
    # The start is what adaptive ranking pairs with the turn's search (ADR-0014):
    # the agent chose this tool, whoever ran it.
    catalog.record_event(
        {"type": "invoke_start", "tool_id": tool_id, "args_size_bytes": 0}, projection
    )
    terminal = dict(projection)
    terminal["event_id"] = new_runtime_event_id()
    if error is None:
        event: dict[str, Any] = {"type": "invoke_end", "tool_id": tool_id, "took_ms": elapsed}
    else:
        event = {
            "type": "invoke_error",
            "tool_id": tool_id,
            "took_ms": elapsed,
            "error": _error_message(error),
        }
    catalog.record_event(event, terminal)  # type: ignore[arg-type]
