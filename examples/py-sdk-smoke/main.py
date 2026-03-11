"""SDK smoke test — requires agentified-core with AGENTIFIED_STORAGE=sqlite"""

import asyncio
import os
import time

from agentified import Agentified, BackendTool, RegisterInput


SERVER = os.environ.get("AGENTIFIED_URL", "http://localhost:9119")
SESSION_ID = f"smoke-{int(time.time() * 1000)}"


def check(condition: bool, msg: str) -> None:
    if not condition:
        raise AssertionError(f"FAIL: {msg}")


async def main() -> None:
    ag = Agentified()
    await ag.connect(SERVER)
    print(f"[1] Connected to {SERVER}")

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
    print("[2] Registered tools")

    session = instance.session(SESSION_ID)
    print(f"[3] Session: {SESSION_ID}")

    # --- updateConversation ---
    messages = [
        {"role": "user", "content": "What's the weather in Rome?"},
        {"role": "assistant", "content": "Let me check the weather in Rome for you."},
        {"role": "user", "content": "Also search docs about TypeScript."},
    ]
    await session.update_conversation(messages)
    print("[4] updateConversation: 3 messages persisted")

    # --- conversation.messages ---
    stored = await session.conversation.messages()
    print(f"[5] conversation.messages: {len(stored)} messages")
    check(len(stored) == 3, f"expected 3 stored, got {len(stored)}")

    # --- context.assemble ---
    ctx = await session.context.messages(strategy="recent").assemble()
    print(f"[6] context.assemble: {ctx.included_messages}/{ctx.total_messages} msgs, strategy={ctx.strategy_used}")
    check(len(ctx.messages) == 3, f"expected 3 context msgs, got {len(ctx.messages)}")

    # --- discoverTool (may fail if OPENAI_API_KEY is invalid) ---
    try:
        discovered = await session.discover_tool.execute({"query": "weather forecast"})
        print(f"[7] discoverTool: {len(discovered)} tools found")
    except Exception as e:
        print(f"[7] discoverTool: SKIPPED ({str(e)[:80]})")

    # --- getMessages ---
    from agentified import GetMessagesOptions

    msgs = await session.get_messages(GetMessagesOptions(strategy="recent"))
    print(f"[8] getMessages: {len(msgs.messages)} messages")
    check(len(msgs.messages) == 3, f"expected 3, got {len(msgs.messages)}")

    # --- conversation.append ---
    await session.conversation.append([{"role": "user", "content": "Thanks!"}])
    all_msgs = await session.conversation.messages()
    print(f"[9] after append: {len(all_msgs)} messages")
    check(len(all_msgs) == 4, f"expected 4 after append, got {len(all_msgs)}")

    # --- updateConversation dedup ---
    await session.update_conversation([*messages, {"role": "user", "content": "Thanks!"}])
    after_dedup = await session.conversation.messages()
    print(f"[10] updateConversation dedup: {len(after_dedup)} messages (should still be 4)")
    check(len(after_dedup) == 4, f"expected 4 after dedup, got {len(after_dedup)}")

    await ag.disconnect()
    print("\n✓ All checks passed!")


if __name__ == "__main__":
    asyncio.run(main())
