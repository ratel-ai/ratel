# `integrations/`

Drop-in tracing wrappers for LLM provider SDKs. Each wraps the client's `create`
method so calls auto-emit generation observations (model, prompt, output, token
usage) through the [`observability/`](../observability/) layer. Provider SDKs are
optional and imported lazily; a clear hint is raised if one is missing.

Prefer the top-level shims [`ratel_ai.openai`](../openai.py) and
[`ratel_ai.anthropic`](../anthropic.py) over importing these modules directly.

They can also (opt-in) apply Ratel's BM25 ranking to the `tools` a caller already
passes, pruning to the top-K per call to save tokens with no `ToolCatalog`
([ADR-0015](../../../../../docs/adr/0015-transparent-tool-selection.md)).

## Layout

```
_wrap.py      shared engine: ProviderSpec + create-method wrapping (sync/async/stream)
selection.py  ToolSelection config + ToolAdapter + rank_tools() (transparent BM25 prune)
openai.py     OpenAI spec + tool adapter, wrap_openai(), OpenAI / AsyncOpenAI constructors
anthropic.py  Anthropic spec + tool adapter, wrap_anthropic(), Anthropic / AsyncAnthropic
```

## Usage

```python
from ratel_ai.openai import OpenAI          # drop-in for `from openai import OpenAI`

client = OpenAI()
client.chat.completions.create(model="gpt-4o", messages=[...])   # auto-traced

# already have a client? trace it in place:
from ratel_ai.openai import wrap_openai
wrap_openai(existing_client)

# opt in to transparent tool selection (BM25-prune `tools` to the top-K):
client = OpenAI(select_tools=True)
```
