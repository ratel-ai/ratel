from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Union

from pydantic import BaseModel, ConfigDict, Field


# Search strategy

SearchStrategy = Literal["bm25", "semantic", "hybrid"]


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
    always_include: bool | None = None
    type: str | None = None
    server_uri: str | None = None


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
    strategy: SearchStrategy | None = None


class CaptureTurnOptions(BaseModel):
    tools_loaded: list[str]
    message: str


class CaptureTurnResponse(BaseModel):
    turn_id: str


class DiscoverToolInput(BaseModel):
    query: str
    limit: int | None = None
    strategy: SearchStrategy | None = None


class TokenUsage(BaseModel):
    input: int
    output: int
    cached: int
    reasoning: int


# Message persistence types

class StoredMessage(BaseModel):
    id: str
    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: Any | None = None
    created_at: str
    seq: int


class AppendMessagesResponse(BaseModel):
    appended: int
    first_seq: int
    last_seq: int


class GetMessagesOpts(BaseModel):
    limit: int | None = None
    after_seq: int | None = None
    around_seq: int | None = None


class GetMessagesResponse(BaseModel):
    messages: list[StoredMessage]
    has_more: bool
    max_seq: int


# Context types

ContextStrategy = Literal["recent", "full", "compacted"]


# Recall types

class RecallToolsConfig(BaseModel):
    limit: int | None = None
    min_similarity: float | None = None


class RecallConfig(BaseModel):
    tools: bool | RecallToolsConfig | None = None


class ContextOpts(BaseModel):
    strategy: ContextStrategy | None = None
    max_tokens: int | None = None
    prune_threshold: int | None = None
    keep_first: bool | None = None


class SummaryRange(BaseModel):
    first_seq: int
    last_seq: int
    count: int


class ContextResponse(BaseModel):
    messages: list[StoredMessage]
    strategy_used: ContextStrategy
    total_messages: int
    included_messages: int
    recalled: dict[str, Any]
    token_estimate: int
    conversation_messages: int
    fallback: bool
    summary: str | None = None
    summary_range: SummaryRange | None = None


class AssembledContext(BaseModel):
    messages: list[StoredMessage]
    recalled: dict[str, Any]
    strategy_used: ContextStrategy
    fallback: bool
    token_estimate: int
    conversation_messages: int
    total_messages: int
    included_messages: int
    tools: dict[str, Any] = {}
    summary: str | None = None
    summary_range: SummaryRange | None = None


class GetMessagesOptions(BaseModel):
    max_messages: int | None = None
    max_tokens: int | None = None
    strategy: ContextStrategy | None = None


class GetMessagesResult(BaseModel):
    messages: list[StoredMessage]
    total_messages: int
    included_messages: int
    strategy_used: ContextStrategy
    fallback: bool


# High-level SDK types

@dataclass
class BackendTool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]
    type: str | None = None  # "backend" or None
    always_include: bool | None = None


@dataclass
class ClientTool:
    name: str
    description: str
    parameters: dict[str, Any]
    type: Literal["client"] = "client"


@dataclass
class McpTool:
    name: str
    description: str
    parameters: dict[str, Any]
    server: str
    handler: Callable[[dict[str, Any]], Any]
    type: Literal["mcp"] = "mcp"


AgentifiedTool = Union[BackendTool, ClientTool, McpTool]


@dataclass
class RegisterInput:
    tools: list[AgentifiedTool]


# Skills — molecules composed of tool atoms

EdgeSource = Literal["developer", "inspector", "agentic"]


class SkillEdge(BaseModel):
    # `from` is a Python keyword, so the attribute uses the trailing-underscore
    # convention while the wire format keeps the JSON field name "from".
    # Callers should serialize with `model_dump(by_alias=True, exclude_none=True)`.
    from_: str = Field(alias="from")
    to: str
    source: EdgeSource | None = None

    model_config = ConfigDict(populate_by_name=True)


class Skill(BaseModel):
    name: str
    description: str
    intent: str | None = None
    atoms: list[str]
    edges: list[SkillEdge] | None = None
    metadata: dict[str, Any] | None = None


class RegisterSkillsResponse(BaseModel):
    registered: int


class ListSkillsResponse(BaseModel):
    skills: list[Skill]


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


# Non-serializable containers

@dataclass
class DiscoverTool:
    definition: ToolDefinition
    execute: Callable[[DiscoverToolInput], Awaitable[list[RankedTool]]]
    discovered_names: set[str] = field(default_factory=set)


class GetMessagesToolInput(BaseModel):
    limit: int | None = None
    after_seq: int | None = None
    around_seq: int | None = None


@dataclass
class GetMessagesTool:
    definition: ToolDefinition
    execute: Callable[[GetMessagesToolInput], Awaitable[GetMessagesResponse]]


@dataclass
class ApiClientConfig:
    server_url: str
    tools: list[ServerTool]
    on_event: Callable[[AgentifiedEvent], None] | None = field(default=None)
    headers: dict[str, str] | None = field(default=None)
    strategy: SearchStrategy | None = field(default=None)


# Legacy alias — kept for backward compat during migration
AgentifiedConfig = ApiClientConfig
