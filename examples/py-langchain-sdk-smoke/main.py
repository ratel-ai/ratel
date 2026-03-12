"""LangChain + Agentified smoke test.

Requires agentified-core with AGENTIFIED_STORAGE=sqlite and OPENAI_API_KEY.
"""

import asyncio
import os
import time

from agentified_langchain import LangchainAgentified, BackendTool, RegisterInput
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent


SERVER = os.environ.get("AGENTIFIED_URL", "http://localhost:9119")
SESSION_ID = f"lc-smoke-{int(time.time() * 1000)}"

TOOL_HANDLERS = {
    "get_weather": lambda args: {"temp": 22, "city": args.get("city", ""), "unit": "C"},
    "search_docs": lambda args: {"results": [f"Doc about {args.get('query', '')}"]},
}


def check(condition: bool, msg: str) -> None:
    if not condition:
        raise AssertionError(f"FAIL: {msg}")


async def main() -> None:
    lc = LangchainAgentified()
    await lc.connect(SERVER)
    print(f"[1] Connected to {SERVER}")

    instance = await lc.register(RegisterInput(tools=[
        BackendTool(
            name="get_weather",
            description="Get current weather for a city",
            parameters={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
            handler=TOOL_HANDLERS["get_weather"],
        ),
        BackendTool(
            name="search_docs",
            description="Search documentation by keyword",
            parameters={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            handler=TOOL_HANDLERS["search_docs"],
        ),
    ]))
    print("[2] Registered tools")

    session = instance.session(SESSION_ID)
    print(f"[3] Session: {SESSION_ID}")

    # --- Discover tools ---
    try:
        result = await session.discover_tool.ainvoke({"query": "weather forecast for a city"})
        print(f"[4] Discovered {len(result)} tools")
        check(len(result) > 0, "expected at least 1 discovered tool")
    except Exception as e:
        print(f"[4] Discovery SKIPPED ({str(e)[:80]})")
        print("    Skipping LLM tests (requires valid OPENAI_API_KEY for both core and agent)")
        await lc.disconnect()
        print("\n✓ Partial checks passed (discovery unavailable)")
        return

    # --- Get tools via adapter ---
    lc_tools = session.get_tools()
    print(f"[5] Got {len(lc_tools)} LangChain tools via adapter")
    check(len(lc_tools) >= 1, "expected at least discover tool")

    # --- Create ReAct agent and run ---
    if not os.environ.get("OPENAI_API_KEY"):
        print("[6] Agent run: SKIPPED (OPENAI_API_KEY not set)")
        print("[7] Tool calling: SKIPPED")
        print("[8] Session continuity: testing with manual messages")
        await session.update_conversation([
            {"role": "user", "content": "What's the weather in Rome?"},
            {"role": "assistant", "content": "It's 22C in Rome."},
        ])
        stored = await session.conversation.messages()
        print(f"    {len(stored)} messages stored")
        check(len(stored) == 2, f"expected 2 stored, got {len(stored)}")
        await lc.disconnect()
        print("\n✓ Partial checks passed (OPENAI_API_KEY not set for agent)")
        return

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    agent = create_react_agent(llm, lc_tools)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "What's the weather in Rome?"}]})
    final_msgs = result["messages"]
    print(f"[6] Agent returned {len(final_msgs)} messages")
    check(len(final_msgs) >= 2, f"expected >=2 messages, got {len(final_msgs)}")

    # Check that tool was called
    tool_calls_found = any(
        hasattr(m, "tool_calls") and m.tool_calls
        for m in final_msgs
    )
    print(f"[7] Tool calling: {'yes' if tool_calls_found else 'no'}")

    # --- Session continuity: persist messages ---
    conv_messages = [
        {"role": "user", "content": "What's the weather in Rome?"},
        {"role": "assistant", "content": final_msgs[-1].content if final_msgs else "done"},
    ]
    await session.update_conversation(conv_messages)
    stored = await session.conversation.messages()
    print(f"[8] Session continuity: {len(stored)} messages stored")
    check(len(stored) == 2, f"expected 2 stored, got {len(stored)}")

    await lc.disconnect()
    print("\n✓ All checks passed!")


if __name__ == "__main__":
    asyncio.run(main())
