from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agentified import Agentified, BackendTool, RegisterInput, ServerTool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.prebuilt import create_react_agent

from quickhr.tools import ALL_TOOLS, TOOLS_BY_NAME

SYSTEM_PROMPT = """You are an AI assistant embedded in QuickHR, an HR management platform.
Your role is to help HR managers and employees with HR-related tasks including:
- Employee management (viewing, adding, updating records)
- Time off and PTO requests
- Onboarding new employees
- Payroll inquiries
- Recruiting and hiring
- Benefits management
- Compliance and policies

Guidelines:
- Be professional, helpful, and efficient
- Use available tools to look up information and perform actions
- Follow company policies when processing requests
- For read-only operations (listing, viewing, searching), use tools immediately
- For write operations (adding, updating, deleting), confirm with the user first
"""

PREFETCH_LIMIT = 15


@dataclass
class HRAgent:
    _ag: Agentified
    _instance: Any
    _llm: ChatGoogleGenerativeAI

    async def run_turn(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        session = self._instance.session("quickhr")
        discovered = await session.discover_tool.execute({
            "query": messages[-1]["content"] if messages else "",
            "limit": PREFETCH_LIMIT,
        })
        turn_tools = [TOOLS_BY_NAME[r.name] for r in discovered if r.name in TOOLS_BY_NAME]
        graph = create_react_agent(self._llm, turn_tools, prompt=SYSTEM_PROMPT)
        return await graph.ainvoke({"messages": messages})


async def create_hr_agent(
    agentified_url: str,
    *,
    google_api_key: str | None = None,
    model: str = "gemini-3-flash-preview",
) -> HRAgent:
    backend_tools = [
        BackendTool(
            name=t.name,
            description=t.description,
            parameters=t.get_input_schema().model_json_schema(),
            handler=lambda args, tool=t: tool.invoke(args),
        )
        for t in ALL_TOOLS
    ]

    ag = Agentified()
    await ag.connect(agentified_url)
    instance = await ag.register(RegisterInput(tools=backend_tools))

    llm = ChatGoogleGenerativeAI(model=model, google_api_key=google_api_key)

    return HRAgent(_ag=ag, _instance=instance, _llm=llm)
