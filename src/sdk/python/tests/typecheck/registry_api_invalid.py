"""Consumer calls that the public registry typing must reject."""

from ratel_ai import Skill, SkillRegistry, Tool, ToolRegistry

ToolRegistry(bogus="value")
ToolRegistry(huggingface="org/model", local="/models/local")
ToolRegistry(url="https://example.test/embeddings", model="embed-v1", pooling="mean")
ToolRegistry(ollama="nomic-embed-text", api_key_env="API_KEY")
ToolRegistry(embedding={"bogus": "value"})
ToolRegistry(embedding={"huggingface": "org/model", "local": "/models/local"})
SkillRegistry(huggingface="org/model", ollama="nomic-embed-text")
SkillRegistry(embedding={})

tools = ToolRegistry()
skills = SkillRegistry()


async def _register() -> None:
    await tools.register("id", "name", "description")
    await tools.register(Tool(id="id", name="name", description="description"), "extra")

    await skills.register("id", "name", "description", [], [], {})
    await skills.register(Skill(id="id", name="name", description="description"), "extra")
