from agentified.models import RankedTool, ServerTool

TEST_URL = "http://localhost:9119"

TEST_TOOL = ServerTool(
    name="get_weather",
    description="Get weather for a city",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
)

RANKED_TOOL = RankedTool(
    **TEST_TOOL.model_dump(),
    score=0.95,
)
