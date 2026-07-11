<div align="center">
  <h1>ratel-ai</h1>
  <p>Context engineering for Python agents.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/ratel">GitHub</a> •
    <a href="https://discord.gg/75vAPdjYqT">Discord</a>
  </p>

  <p>
    <a href="https://pypi.org/project/ratel-ai/"><img src="https://img.shields.io/pypi/v/ratel-ai?label=pypi&color=3775a9" alt="PyPI" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://github.com/ratel-ai/ratel/blob/main/LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  </p>
</div>

`ratel-ai` retrieves the tools and skills relevant to each agent turn instead of sending the full catalog to the model. It bundles Ratel's Rust engine in-process: BM25 by default, with local semantic and hybrid retrieval available when needed. No API key, vector database, service, or Rust toolchain is required.

Use `ToolCatalog` for ranked tools with sync or async handlers, or expose `search_capabilities_tool` and `invoke_tool_tool` so an agent can search and invoke the catalog on demand. Existing MCP servers can be ingested with the `mcp` extra.

## Install

```bash
pip install ratel-ai
# MCP ingestion: pip install 'ratel-ai[mcp]'
```

## Quickstart

Save as `quickstart.py`, then run `python quickstart.py`:

```python
import asyncio
from ratel_ai import ExecutableTool, ToolCatalog

async def main():
    catalog = ToolCatalog()
    catalog.register(
        ExecutableTool(
            id="get_weather",
            name="get_weather",
            description="Get the current weather for a city.",
            input_schema={"properties": {"city": {"type": "string"}}},
            output_schema={"type": "object"},
            execute=lambda args: {"forecast": f"Sunny in {args['city']}"},
        )
    )

    hit = catalog.search("What is the weather in Rome?", 1)[0]
    print(await catalog.invoke(hit.tool_id, {"city": "Rome"}))


asyncio.run(main())
```

Continue with the [Python guide](https://docs.ratel.sh/docs/sdks/python), [capability tools](https://docs.ratel.sh/docs/capability-tools), [API reference](https://docs.ratel.sh/docs/api/sdk-python), or the [Pydantic AI example](https://github.com/ratel-ai/ratel/tree/main/examples/pydantic-ai).

Telemetry export is optional. With the `otlp` extra installed, `configure_telemetry()` reads `RATEL_URL` and `RATEL_API_KEY`, wires the exporter, and returns a shutdown handle. See the [telemetry guide](https://docs.ratel.sh/docs/telemetry).

Package layout: `ratel_ai/` is the Python surface, `native/` contains the PyO3 binding, and `tests/` exercises both. For local development, create `.venv` with `uv`, install `maturin`, `pytest`, `ruff`, and `mypy`, then run `.venv/bin/maturin develop` and `.venv/bin/pytest`.
