# `integrations/`

Drop-in tracing wrappers for LLM provider SDKs. Each wraps the client's `create`
method so calls auto-emit generation observations (model, prompt, output, token
usage) through the [`observability/`](../observability/) layer. Provider SDKs are
optional and imported lazily; a clear hint is raised if one is missing.

Prefer the top-level shims [`ratel_ai.openai`](../openai.py) and
[`ratel_ai.anthropic`](../anthropic.py) over importing these modules directly.

## Layout

```
_wrap.py      shared engine: ProviderSpec + create-method wrapping (sync/async/stream)
openai.py     OpenAI spec, wrap_openai(), OpenAI / AsyncOpenAI traced constructors
anthropic.py  Anthropic spec, wrap_anthropic(), Anthropic / AsyncAnthropic constructors
```

## Usage

```python
from ratel_ai.openai import OpenAI          # drop-in for `from openai import OpenAI`

client = OpenAI()
client.chat.completions.create(model="gpt-4o", messages=[...])   # auto-traced

# already have a client? trace it in place:
from ratel_ai.openai import wrap_openai
wrap_openai(existing_client)
```
