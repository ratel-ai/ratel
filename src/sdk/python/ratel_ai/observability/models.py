"""Wire models for the SDK→cloud ingestion contract (ADR-0013).

These dataclasses are the source of truth for the JSON shape the exporter ships
to `POST {host}/v1/ingest`. Each carries a `to_wire()` that produces the exact
dict. The shape is Langfuse-isomorphic with OpenTelemetry-GenAI-named LLM
attributes, so cloud-side Langfuse forwarding is a near-mechanical field map.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = 1
SDK_NAME = "ratel-ai-python"

# Observation kinds and statuses — mirror the core schema (ADR-0012).
OBSERVATION_SPAN = "span"
OBSERVATION_GENERATION = "generation"
OBSERVATION_EVENT = "event"

STATUS_OK = "ok"
STATUS_ERROR = "error"


def sdk_version() -> str:
    """Best-effort package version for the `sdk` block; never raises."""
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("ratel-ai")
        except PackageNotFoundError:
            return "0.0.0"
    except Exception:
        return "0.0.0"


def _approx_len(value: Any) -> int:
    """Cheap size hint used when content capture is disabled."""
    try:
        if isinstance(value, str):
            return len(value)
        return len(repr(value))
    except Exception:
        return 0


_MAX_JSON_DEPTH = 12


def _jsonable(value: Any, _depth: int = 0) -> Any:
    """Coerce an arbitrary value into something JSON-serializable, recursively.

    Provider response objects, dataclasses, and odd types are handled by falling
    back to known attributes or `str()`. Bounded depth guards against deeply
    nested or cyclic objects (e.g. self-referential model graphs). Never raises.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if _depth >= _MAX_JSON_DEPTH:
        # Too deep (or cyclic) — stop recursing and stringify, bounded.
        try:
            return str(value)[:500]
        except Exception:
            return None
    if isinstance(value, dict):
        return {str(k): _jsonable(v, _depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, _depth + 1) for v in value]
    if isinstance(value, (set, frozenset)):
        # Sets have no stable iteration order — sort by repr for determinism.
        return [_jsonable(v, _depth + 1) for v in sorted(value, key=repr)]
    for attr in ("model_dump", "to_dict", "dict"):
        method = getattr(value, attr, None)
        if callable(method):
            try:
                return _jsonable(method(), _depth + 1)
            except Exception:
                pass
    to_d = getattr(value, "__dict__", None)
    if isinstance(to_d, dict) and to_d:
        return {
            str(k): _jsonable(v, _depth + 1)
            for k, v in to_d.items()
            if not str(k).startswith("_")
        }
    try:
        return str(value)
    except Exception:
        return None


def capture_field(value: Any, enabled: bool) -> dict[str, Any]:
    """Render an input/output field honoring the capture toggle.

    Captured → `{"captured": True, "value": <jsonable>}`.
    Suppressed → `{"captured": False, "length": <int>}` (content omitted).
    """
    if not enabled:
        return {"captured": False, "length": _approx_len(value)}
    return {"captured": True, "value": _jsonable(value)}


def usage_block(usage: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize a token-usage dict to the wire `usage` keys, dropping unknowns."""
    if not usage:
        return None
    out: dict[str, Any] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        val = usage.get(key)
        if val is not None:
            out[key] = int(val)
    if "total_tokens" not in out and "input_tokens" in out and "output_tokens" in out:
        out["total_tokens"] = out["input_tokens"] + out["output_tokens"]
    return out or None


def gen_ai_block(
    *,
    system: str,
    request_model: str,
    response_model: str | None = None,
    request_params: dict[str, Any] | None = None,
    finish_reasons: list[str] | None = None,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the OTel-GenAI-named `gen_ai` sub-object for a generation."""
    request: dict[str, Any] = {"model": request_model}
    if request_params:
        request.update(_jsonable(request_params))
    block: dict[str, Any] = {"system": system, "request": request}
    response: dict[str, Any] = {}
    if response_model:
        response["model"] = response_model
    if finish_reasons:
        response["finish_reasons"] = list(finish_reasons)
    if response:
        block["response"] = response
    normalized = usage_block(usage)
    if normalized:
        block["usage"] = normalized
    return block


@dataclass(frozen=True)
class TraceCreate:
    """Opens or upserts a trace (root of a tree)."""

    id: str
    trace_id: str
    timestamp: int
    name: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    tags: list[str] = field(default_factory=list)
    version: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    release: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "trace-create",
            "timestamp": self.timestamp,
            "trace_id": self.trace_id,
            "name": self.name,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "tags": list(self.tags),
            "version": self.version,
            "metadata": dict(self.metadata),
            "release": self.release,
        }


@dataclass(frozen=True)
class ObservationCreate:
    """A span, generation, or event within a trace."""

    id: str
    trace_id: str
    observation_id: str
    observation_type: str
    timestamp: int
    name: str | None = None
    parent_observation_id: str | None = None
    start_time: int | None = None
    end_time: int | None = None
    status: str = STATUS_OK
    status_message: str | None = None
    level: str = "default"
    input: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    gen_ai: dict[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "id": self.id,
            "type": "observation-create",
            "timestamp": self.timestamp,
            "trace_id": self.trace_id,
            "observation_id": self.observation_id,
            "parent_observation_id": self.parent_observation_id,
            "observation_type": self.observation_type,
            "name": self.name,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "status": self.status,
            "status_message": self.status_message,
            "level": self.level,
            "input": self.input,
            "output": self.output,
            "metadata": dict(self.metadata),
        }
        if self.gen_ai is not None:
            wire["gen_ai"] = self.gen_ai
        return wire


def build_batch(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Wrap a list of wire events in the versioned ingestion envelope."""
    return {
        "schema_version": SCHEMA_VERSION,
        "sdk": {"name": SDK_NAME, "version": sdk_version()},
        "batch": events,
    }
