# Getting Started (Python)

Register 200 tools. Get the 5 that matter. **86% fewer tokens, same accuracy.**

## Prerequisites

- **Docker** (to run agentified-core)
- **Python 3.10+**
- **`OPENAI_API_KEY`** — for `text-embedding-3-small` embeddings

## 1. Start the server

```bash
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core
```

Verify:

```bash
curl http://localhost:9119/health
# {"status":"ok"}
```

## 2. Install

```bash
pip install agentified
```

## 3. Paste and run

Create `main.py`:

```python
import asyncio
from agentified import Agentified, BackendTool, RegisterInput

async def main():
    ag = Agentified()
    await ag.connect("http://localhost:9119")

    instance = await ag.register(RegisterInput(tools=[
        BackendTool(name="get_weather", description="Get current weather for a city",
                    parameters={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
                    handler=lambda args: {"temp": 22, "city": args["city"]}),
        BackendTool(name="search_docs", description="Search documentation by keyword",
                    parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
                    handler=lambda args: {"results": [f"Doc about {args['query']}"]}),
    ]))

    session = instance.session("my-session")
    discovered = await session.discover_tool.execute({"query": "What's the weather in Rome?"})
    print("Discovered tools:", [(t.name, t.score) for t in discovered])

    await ag.disconnect()

asyncio.run(main())
```

Run:

```bash
python main.py
```

## 4. What happened

The server:

1. **Embedded** your query using `text-embedding-3-small`
2. **Scored** tools via weighted cosine similarity across name, description, and schemas
3. **Combined** with BM25 keyword matching: `final = 0.7 × semantic + 0.3 × BM25`
4. **Returned** the top-K tools sorted by relevance

Read [Architecture](../server/architecture.md) for the full deep dive.

## Next steps

- **[LangGraph Integration](./integrations/langgraph.md)** — Python + LangGraph + OpenAI example
- **[SDK API Reference](../../src/py-packages/sdk/README.md)** — Full Python API
- **[py-sdk-smoke example](../../examples/py-sdk-smoke/)** — Minimal smoke test
- **[py-langchain-sdk-smoke example](../../examples/py-langchain-sdk-smoke/)** — LangChain integration
