"""Python Agentified benchmark agent.

Uses LangGraph ReAct agent with Agentified tool discovery via LangChain adapter.
Requires OPENAI_API_KEY and agentified-core running.
"""

import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scaffolding", "py"))
from scaffolding import start_agent, execute_tool

from agentified_langchain import LangchainAgentified, BackendTool, RegisterInput
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

MODEL = os.environ.get("MODEL", "gpt-5")
SYSTEM_PROMPT = """You are an HR assistant with access to tools.

**Tool usage rules:**
- ALWAYS consider using the tools, do not be afraid of using them. Do not ask confirmation if the plan is clear.
- Use tools to answer factual questions — never guess from memory.
- If a request is outside your capabilities or no relevant tools exist, say so.
- If a tool requires an input you don't have (e.g. employeeId), use agentified_discover to find how to obtain it from information in the user's request."""
MAX_STEPS = 10
TOOL_LIMIT = 0 if os.environ.get("FORCE_DISCOVERY") == "1" else 15

lc: LangchainAgentified | None = None
instance = None
llm = None
tool_scripts: dict[str, str] = {}


def setup(tool_defs, cfg):
    global lc, instance, llm, tool_scripts

    endpoint = cfg.get("agentifiedEndpoint") or os.environ.get("AGENTIFIED_ENDPOINT", "http://localhost:9119")
    model = cfg.get("model", MODEL)

    backend_tools = []
    for t in tool_defs:
        script = t.get("script", "")
        tool_scripts[t["name"]] = script
        backend_tools.append(BackendTool(
            name=t["name"],
            description=t.get("description", ""),
            parameters=t.get("parameters", {}),
            handler=lambda args, s=script: execute_tool(s, args),
        ))

    lc_instance = LangchainAgentified()
    loop = asyncio.new_event_loop()
    loop.run_until_complete(lc_instance.connect(endpoint))
    inst = loop.run_until_complete(lc_instance.register(RegisterInput(tools=backend_tools)))
    loop.close()

    lc = lc_instance
    instance = inst
    llm = ChatOpenAI(model=model, temperature=0)
    print(json.dumps({"event": "setup_complete", "tools": len(backend_tools), "endpoint": endpoint}), file=sys.stderr, flush=True)


def send_message(body):
    history = body.get("history", [])
    seed = body.get("seed", 0)

    session = instance.session(f"bench-{seed}")
    loop = asyncio.new_event_loop()

    start = time.perf_counter()

    # Discover tools
    try:
        loop.run_until_complete(
            session.discover_tool.ainvoke({"query": history[-1]["content"] if history else "", "limit": TOOL_LIMIT or 15})
        )
    except Exception:
        pass

    # Get tools via adapter (discover + discovered backend tools)
    lc_tools = session.get_tools()
    hydrated_names = [t.name for t in lc_tools if t.name != "agentified_discover"]

    # Run agent
    agent = create_react_agent(llm, lc_tools, prompt=SYSTEM_PROMPT)
    messages = [{"role": m["role"], "content": m["content"]} for m in history]
    result = loop.run_until_complete(agent.ainvoke({"messages": messages}))
    loop.close()

    duration_ms = (time.perf_counter() - start) * 1000

    final_msgs = result.get("messages", [])
    last_msg = final_msgs[-1] if final_msgs else None
    content = last_msg.content if last_msg and hasattr(last_msg, "content") else ""

    # Extract tool calls
    tool_calls = []
    for m in final_msgs:
        if hasattr(m, "tool_calls") and m.tool_calls:
            for tc in m.tool_calls:
                tool_calls.append({
                    "toolCallId": tc.get("id", ""),
                    "toolName": tc.get("name", ""),
                    "args": tc.get("args", {}),
                })

    # Extract usage (approximate from LangChain response metadata)
    usage = {"totalTokens": 0, "inputTokens": 0, "outputTokens": 0}
    for m in final_msgs:
        if hasattr(m, "response_metadata"):
            meta = m.response_metadata or {}
            token_usage = meta.get("token_usage", {})
            usage["totalTokens"] += token_usage.get("total_tokens", 0)
            usage["inputTokens"] += token_usage.get("prompt_tokens", 0)
            usage["outputTokens"] += token_usage.get("completion_tokens", 0)

    return {
        "content": content,
        "toolCalls": tool_calls,
        "usage": usage,
        "durationMs": duration_ms,
        "hydratedTools": hydrated_names,
        "debug": {
            "systemPrompt": SYSTEM_PROMPT,
            "toolNames": hydrated_names,
            "modelResponse": content,
            "toolCallsMade": [{"name": tc["toolName"], "args": tc["args"]} for tc in tool_calls],
        },
    }


if __name__ == "__main__":
    start_agent(setup=setup, send_message=send_message)
