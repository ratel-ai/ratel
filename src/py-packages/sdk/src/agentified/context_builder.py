from __future__ import annotations

from typing import Any, Awaitable, Callable, TYPE_CHECKING

from .models import (
    AssembledContext,
    BackendTool,
    ContextStrategy,
    McpTool,
    RecallConfig,
    StoredMessage,
    SummaryRange,
)

if TYPE_CHECKING:
    from .api_client import ApiClient

AgentifiedTool = BackendTool | McpTool

CompactionStrategy = Callable[[list[StoredMessage]], Awaitable[dict[str, str]]]


class ContextBuilder:
    def __init__(
        self,
        sdk: ApiClient,
        dataset_id: str,
        namespace_id: str,
        session_id: str,
        registered_tools: list[Any] | None = None,
        discovered_names: set[str] | None = None,
    ) -> None:
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._namespace_id = namespace_id
        self._session_id = session_id
        self._registered_tools = registered_tools or []
        self._discovered_names = discovered_names or set()
        self._strategy: ContextStrategy | None = None
        self._max_tokens: int | None = None
        self._prune_threshold: int | None = None
        self._keep_first: bool | None = None
        self._compaction_strategy: CompactionStrategy | None = None
        self._recall_config: RecallConfig | None = None
        self._token_limit: int | None = None
        self._explicit_tools: dict[str, Any] = {}

    def messages(
        self,
        strategy: ContextStrategy | None = None,
        max_tokens: int | None = None,
        prune_threshold: int | None = None,
        keep_first: bool | None = None,
        compaction_strategy: CompactionStrategy | None = None,
    ) -> ContextBuilder:
        self._strategy = strategy
        self._max_tokens = max_tokens
        self._prune_threshold = prune_threshold
        self._keep_first = keep_first
        self._compaction_strategy = compaction_strategy
        return self

    def tools(self, tools: dict[str, Any]) -> ContextBuilder:
        self._explicit_tools.update(tools)
        return self

    def recall(self, config: RecallConfig | None = None) -> ContextBuilder:
        self._recall_config = config if config is not None else RecallConfig(tools=True)
        return self

    def limit_tokens(self, budget: int) -> ContextBuilder:
        self._token_limit = budget
        return self

    async def assemble(self) -> AssembledContext:
        is_client_compaction = (
            self._compaction_strategy is not None
            and self._strategy == "compacted"
        )

        res = await self._sdk.get_context(
            self._dataset_id, self._namespace_id, self._session_id,
            strategy="recent" if is_client_compaction else self._strategy,
            max_tokens=self._max_tokens,
            prune_threshold=self._prune_threshold,
            keep_first=self._keep_first,
            recall=self._recall_config,
            limit_tokens=self._token_limit,
        )

        # Client-side compaction
        if is_client_compaction and self._compaction_strategy:
            all_msgs = await self._sdk.get_messages(
                self._dataset_id, self._namespace_id, self._session_id,
            )
            recent_seqs = {m.seq for m in res.messages}
            older_messages = [m for m in all_msgs.messages if m.seq not in recent_seqs]

            if older_messages:
                result = await self._compaction_strategy(older_messages)
                summary = result.get("summary", "")
                first_seq = older_messages[0].seq
                last_seq = older_messages[-1].seq
                res.summary = summary
                res.summary_range = SummaryRange(
                    first_seq=first_seq, last_seq=last_seq, count=len(older_messages),
                )
                res.strategy_used = "compacted"

        # Construct summary message and inject into messages array
        final_messages: list[StoredMessage] = list(res.messages)
        if res.summary and res.summary_range:
            sr = res.summary_range
            summary_msg = StoredMessage(
                id="summary",
                role="assistant",
                content=(
                    f"[Summary of messages {sr.first_seq}\u2013{sr.last_seq} "
                    f"({sr.count} messages compacted)]\n{res.summary}"
                ),
                created_at="",
                seq=0,
            )
            first_user_idx = next(
                (i for i, m in enumerate(final_messages) if m.role == "user"), -1,
            )
            if first_user_idx == 0 and len(final_messages) > 0:
                final_messages = [final_messages[0], summary_msg, *final_messages[1:]]
            else:
                final_messages = [summary_msg, *final_messages]

        # Populate discoveredNames from recalled tools for cross-turn accumulation
        recalled = res.recalled or {}
        if recalled.get("tools"):
            for t in recalled["tools"]:
                name = t.get("name") if isinstance(t, dict) else getattr(t, "name", None)
                if name:
                    self._discovered_names.add(name)

        resolved: dict[str, Any] = {**self._explicit_tools}
        for tool in self._registered_tools:
            name = getattr(tool, "name", None)
            if name and name in self._discovered_names and name not in resolved:
                resolved[name] = tool

        return AssembledContext(
            messages=final_messages,
            recalled=res.recalled,
            strategy_used=res.strategy_used,
            fallback=res.fallback,
            token_estimate=res.token_estimate,
            conversation_messages=res.conversation_messages,
            total_messages=res.total_messages,
            included_messages=res.included_messages,
            tools=resolved,
            summary=res.summary,
            summary_range=res.summary_range,
        )
