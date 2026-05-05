from agentified.models import BackendTool, RankedTool, ServerTool

TEST_URL = "http://localhost:9119"

TEST_TOOL = ServerTool(
    name="get_weather",
    description="Get weather for a city",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
)

RANKED_TOOL = RankedTool(**TEST_TOOL.model_dump(), score=0.95)

BACKEND_TOOLS = [
    BackendTool(
        name="get_weather",
        description="Get weather for a city",
        parameters={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        handler=lambda args: {"temp": 22, "city": args.get("city", "")},
    ),
    BackendTool(
        name="search_docs",
        description="Search documentation",
        parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        handler=lambda args: {"results": [f"Doc about {args.get('query', '')}"]},
    ),
]
