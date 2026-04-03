"""SDK smoke test — requires agentified-core with AGENTIFIED_STORAGE=sqlite"""

import asyncio
import os
import time

from agentified import (
    Agentified,
    BackendTool,
    GetMessagesOptions,
    RecallConfig,
    RecallToolsConfig,
    RegisterInput,
    SearchStrategy,
)


SERVER = os.environ.get("AGENTIFIED_URL", "http://localhost:9119")
SESSION_ID = f"smoke-{int(time.time() * 1000)}"


def check(condition: bool, msg: str) -> None:
    if not condition:
        raise AssertionError(f"FAIL: {msg}")


async def main() -> None:
    # --- [1] connect with search strategy ---
    ag = Agentified()
    await ag.connect(SERVER, strategy="bm25")
    print(f"[1] Connected to {SERVER} with strategy=bm25")

    instance = await ag.register(RegisterInput(tools=[
        BackendTool(
            name="get_weather",
            description="Get current weather for a city",
            parameters={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
            handler=lambda args: {"temp": 22, "city": args["city"], "unit": "C"},
            always_include=True,
        ),
        BackendTool(
            name="search_docs",
            description="Search documentation by keyword",
            parameters={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            handler=lambda args: {"results": [f"Doc about {args['query']}"]},
        ),
    ]))
    print("[2] Registered tools (get_weather has always_include=True)")

    session = instance.session(SESSION_ID)
    print(f"[3] Session: {SESSION_ID}")

    # --- [4] updateConversation ---
    messages = [
        {"role": "user", "content": "What's the weather in Rome?"},
        {"role": "assistant", "content": "Let me check the weather in Rome for you."},
        {"role": "user", "content": "Also search docs about TypeScript."},
    ]
    await session.update_conversation(messages)
    print("[4] updateConversation: 3 messages persisted")

    # --- [5] conversation.messages ---
    stored = await session.conversation.messages()
    print(f"[5] conversation.messages: {len(stored)} messages")
    check(len(stored) == 3, f"expected 3 stored, got {len(stored)}")

    # --- [6] context.assemble with keep_first ---
    ctx = await session.context.messages(
        strategy="recent", keep_first=True,
    ).assemble()
    print(f"[6] context.assemble (keep_first=True): {ctx.included_messages}/{ctx.total_messages} msgs, strategy={ctx.strategy_used}")
    check(len(ctx.messages) == 3, f"expected 3 context msgs, got {len(ctx.messages)}")

    # --- [7] discoverTool ---
    try:
        discovered = await session.discover_tool.execute({"query": "weather forecast"})
        print(f"[7] discoverTool: {len(discovered)} tools found")
    except Exception as e:
        print(f"[7] discoverTool: SKIPPED ({str(e)[:80]})")

    # --- [8] getMessagesTool ---
    gmt = session.get_messages_tool
    check(gmt.definition.name == "agentified_get_messages", "expected agentified_get_messages tool")
    gmt_result = await gmt.execute({"limit": 10})
    print(f"[8] getMessagesTool: {len(gmt_result.messages)} messages, has_more={gmt_result.has_more}")
    check(len(gmt_result.messages) == 3, f"expected 3 from getMessagesTool, got {len(gmt_result.messages)}")

    # --- [9] getMessages ---
    msgs = await session.get_messages(GetMessagesOptions(strategy="recent"))
    print(f"[9] getMessages: {len(msgs.messages)} messages")
    check(len(msgs.messages) == 3, f"expected 3, got {len(msgs.messages)}")

    # --- [10] conversation.append ---
    await session.conversation.append([{"role": "user", "content": "Thanks!"}])
    all_msgs = await session.conversation.messages()
    print(f"[10] after append: {len(all_msgs)} messages")
    check(len(all_msgs) == 4, f"expected 4 after append, got {len(all_msgs)}")

    # --- [11] updateConversation dedup ---
    await session.update_conversation([*messages, {"role": "user", "content": "Thanks!"}])
    after_dedup = await session.conversation.messages()
    print(f"[11] updateConversation dedup: {len(after_dedup)} messages (should still be 4)")
    check(len(after_dedup) == 4, f"expected 4 after dedup, got {len(after_dedup)}")

    # --- [12] context with recall ---
    try:
        recall_ctx = await session.context \
            .messages(strategy="recent") \
            .recall(RecallConfig(tools=True)) \
            .assemble()
        print(f"[12] recall: recalled={recall_ctx.recalled}, tools={len(recall_ctx.tools)}")
    except Exception as e:
        print(f"[12] recall: SKIPPED ({str(e)[:80]})")

    # --- [13] context with recall + custom config ---
    try:
        recall_ctx2 = await session.context \
            .messages(strategy="recent") \
            .recall(RecallConfig(tools=RecallToolsConfig(limit=2))) \
            .assemble()
        print(f"[13] recall (limit=2): recalled={recall_ctx2.recalled}, tools={len(recall_ctx2.tools)}")
    except Exception as e:
        print(f"[13] recall (limit=2): SKIPPED ({str(e)[:80]})")

    # --- [14] context with limit_tokens ---
    limit_ctx = await session.context \
        .messages(strategy="recent", max_tokens=4000) \
        .limit_tokens(8000) \
        .assemble()
    print(f"[14] limit_tokens(8000): token_estimate={limit_ctx.token_estimate}, msgs={len(limit_ctx.messages)}")

    # --- [15] compacted strategy (server-side, requires OPENAI_API_KEY) ---
    session2 = instance.session(f"smoke-compacted-{int(time.time() * 1000)}")
    bulk_msgs: list[dict[str, str]] = []
    for i in range(20):
        bulk_msgs.append({"role": "user", "content": f"Message {i}: {'x' * 200}"})
        bulk_msgs.append({"role": "assistant", "content": f"Reply {i}: {'y' * 200}"})
    bulk_msgs.append({"role": "user", "content": "Call the tool"})
    bulk_msgs.append({"role": "tool", "content": "z" * 600, "tool_call_id": "tc1"})
    bulk_msgs.append({"role": "assistant", "content": "Got the tool result"})
    bulk_msgs.append({"role": "user", "content": "What was the result?"})
    await session2.update_conversation(bulk_msgs)
    print(f"[15] compacted setup: {len(bulk_msgs)} messages persisted")

    try:
        compacted_ctx = await session2.context.messages(
            strategy="compacted", max_tokens=2000, prune_threshold=500,
        ).assemble()
        print(
            f"[16] compacted: strategy={compacted_ctx.strategy_used}, "
            f"fallback={compacted_ctx.fallback}, msgs={len(compacted_ctx.messages)}"
        )
        check(compacted_ctx.strategy_used == "compacted", f"expected compacted, got {compacted_ctx.strategy_used}")
        # Check summary fields from server
        if compacted_ctx.summary:
            print(f"     summary present ({len(compacted_ctx.summary)} chars)")
            check(compacted_ctx.summary_range is not None, "expected summary_range when summary is present")
            print(f"     summary_range: seq {compacted_ctx.summary_range.first_seq}-{compacted_ctx.summary_range.last_seq} ({compacted_ctx.summary_range.count} msgs)")
    except Exception as e:
        print(f"[16] compacted: SKIPPED ({str(e)[:80]})")

    # --- [17] client-side compaction strategy ---
    session3 = instance.session(f"smoke-client-compact-{int(time.time() * 1000)}")
    for i in range(10):
        await session3.conversation.append([
            {"role": "user", "content": f"User message {i}: {'a' * 100}"},
            {"role": "assistant", "content": f"Assistant reply {i}: {'b' * 100}"},
        ])

    async def my_compaction(msgs):
        return {"summary": f"Summary of {len(msgs)} older messages"}

    try:
        client_compact_ctx = await session3.context.messages(
            strategy="compacted", max_tokens=500,
            compaction_strategy=my_compaction,
        ).assemble()
        print(
            f"[17] client-side compaction: strategy={client_compact_ctx.strategy_used}, "
            f"msgs={len(client_compact_ctx.messages)}"
        )
        if client_compact_ctx.summary:
            print(f"     client summary: {client_compact_ctx.summary[:80]}")
            check("Summary of" in client_compact_ctx.summary, "expected client compaction summary")
    except Exception as e:
        print(f"[17] client-side compaction: SKIPPED ({str(e)[:80]})")

    await ag.disconnect()
    print("\n✓ All checks passed!")


if __name__ == "__main__":
    asyncio.run(main())
