# ratel-ai-rankers-plugin

Decision-model rankers as retrieve/rerank plugins for [`ratel-ai`](https://pypi.org/project/ratel-ai/), the Ratel Python SDK.

The SDK ranks through functions you give it (`retrieve_fn`, `reranker_fn`; [ADR 0027](../../../docs/adr/0027-custom-retriever-and-reranker-functions.md)) and knows no vendor's API. This package holds the vendor clients, so the SDK stays vendor-free and a new vendor ships without an SDK release ([ADR 0028](../../../docs/adr/0028-vendor-rankers-as-plugin-packages.md)).

```bash
pip install ratel-ai ratel-ai-rankers-plugin
```

## Plugins

Each returns a `RetrieverPlugin` with `.retrieve` (for `retrieve_fn`, `method="custom"`) and `.rerank` (for `reranker_fn`). Every failure raises the SDK's `RetrieverError`. When a reranker fails with `transient=True`, the search keeps the first stage's order.

```python
from ratel_ai import ToolCatalog
from ratel_ai_rankers_plugin import ratel_jev_plugin, ratel_openai_decision_plugin

jev = ratel_jev_plugin()  # key in TYPESAFE_API_KEY
ToolCatalog(method="custom", retrieve_fn=jev.retrieve)   # Jev ranks every tool
ToolCatalog(method="bm25", reranker_fn=jev.rerank)       # Jev reranks BM25's top 50

decision = ratel_openai_decision_plugin()  # key in OPENAI_API_KEY; public beta
ToolCatalog(method="bm25", reranker_fn=decision.rerank, reranker_depth=20)
```

- `ratel_jev_plugin(url=None, api_key_env=None, model=None)`: Jev (TypeSafe AI). Defaults: `https://api.typesafe.ai`, `TYPESAFE_API_KEY`, `jev-latest`.
- `ratel_openai_decision_plugin(url=None, api_key_env=None, model=None)`: OpenAI's Decisions API (public beta). Defaults: `https://api.openai.com`, `OPENAI_API_KEY`, `gpt-6-luna`. The first plugin made emits a one-time `ExperimentalWarning`; set `RATEL_EXPERIMENTAL_SILENCE=1` to silence it. A model refusal is `code="Refused"`, which is transient.

Both plugins send the query and each candidate's searchable text to the vendor. Above 150 candidates they rank groups in parallel and put the group winners into one final question. Picks below probability 0.01 are dropped, except the best one.

## Writing your own plugin

The plugin contract belongs to the SDK. This package re-exports it so a plugin can import everything from one place:

```python
from ratel_ai_rankers_plugin import RankCandidate, RankedId, define_plugin

async def rank(query: str, candidates: list[RankCandidate], top_k: int) -> list[RankedId]:
    ...

my_plugin = define_plugin(retrieve=rank, rerank=rank)
```

`choice_ranker_plugin(ranker)` turns any object with a `rank(query, [(id, text)], top_k, kind)` method into a plugin.

## Layout

```
native/                    pyo3 binding to the ratel-ai-rankers crate (../core)
ratel_ai_rankers_plugin/   the plugins, the shared adapter, type stubs
tests/                     plugin tests against local vendor stand-ins
```

## Build & test

From this directory, with [`uv`](https://docs.astral.sh/uv/):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv maturin pytest pytest-asyncio ruff mypy -e ../../telemetry/python
unset CONDA_PREFIX
# The in-repo SDK, then this package; --no-deps because the SDK's version is only
# bumped at release, so the pin on the next SDK may not be met yet.
uv pip install --python .venv -e ../../sdk/python
uv pip install --python .venv --no-deps -e .
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai_rankers_plugin && .venv/bin/pytest
```

Released as the `rankers-py-v*` unit (ADR-0008).
