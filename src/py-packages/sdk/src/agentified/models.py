from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Union

from pydantic import BaseModel


# Wire-format models (match Rust server snake_case JSON)

class ServerToolFields(BaseModel):
    name: str
    description: str
    input_schema: str | None = None
    output_schema: str | None = None


class ServerTool(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]
    metadata: dict[str, Any] | None = None
    fields: ServerToolFields | None = None


class RankedTool(ServerTool):
    score: float
    graph_expanded: bool | None = None


class ToolDefinition(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]
    metadata: dict[str, Any] | None = None


class RegisterResponse(BaseModel):
    registered: int


class DiscoverResponse(BaseModel):
    tools: list[RankedTool]


class Message(BaseModel):
    role: str
    content: str


class PrefetchOptions(BaseModel):
    messages: list[Message]
    limit: int | None = None
    exclude: list[str] | None = None
    turn_id: str | None = None


class CaptureTurnOptions(BaseModel):
    tools_loaded: list[str]
    message: str


class CaptureTurnResponse(BaseModel):
    turn_id: str


class DiscoverToolInput(BaseModel):
    query: str
    limit: int | None = None


class TokenUsage(BaseModel):
    input: int
    output: int
    cached: int
    reasoning: int


# Event types

class PrefetchStartEvent(BaseModel):
    type: Literal["agentified:prefetch:start"] = "agentified:prefetch:start"
    messages: list[Message]


class PrefetchCompleteEvent(BaseModel):
    type: Literal["agentified:prefetch:complete"] = "agentified:prefetch:complete"
    tools: list[RankedTool]
    duration_ms: float
    token_usage: TokenUsage | None = None


class PrefetchSkippedEvent(BaseModel):
    type: Literal["agentified:prefetch:skipped"] = "agentified:prefetch:skipped"
    tools: list[RankedTool]
    duration_ms: float


class DiscoverStartEvent(BaseModel):
    type: Literal["agentified:discover:start"] = "agentified:discover:start"
    query: str


class DiscoverCompleteEvent(BaseModel):
    type: Literal["agentified:discover:complete"] = "agentified:discover:complete"
    query: str
    tools: list[RankedTool]
    duration_ms: float
    token_usage: TokenUsage | None = None


AgentifiedEvent = Union[
    PrefetchStartEvent,
    PrefetchCompleteEvent,
    PrefetchSkippedEvent,
    DiscoverStartEvent,
    DiscoverCompleteEvent,
]


# Non-serializable containers (use dataclasses for callables)

@dataclass
class DiscoverTool:
    definition: ToolDefinition
    execute: Callable[[DiscoverToolInput], Awaitable[list[RankedTool]]]


@dataclass
class AgentifiedConfig:
    server_url: str
    tools: list[ServerTool]
    on_event: Callable[[AgentifiedEvent], None] | None = field(default=None)
