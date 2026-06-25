---
name: ratel-observability
description: Wire Ratel's lean observability SDK (ratel-ai) into an existing Python agent so every model interaction ships a usage rollup to the dashboard. Attributes token counts to the five context sources (skills/tools/history/memory/user_input), optionally computes Ratel tool savings, and is best-effort — never breaks the host app, no-ops without a key. Invoke when instrumenting a customer's agent for Ratel cloud analytics.
---

# /ratel-observability

Instruments an **existing** Python agent — one that already has its own LLM loop — with Ratel's lean cloud-analytics layer. One `track()` call per model interaction ships a usage rollup to `POST {RATEL_HOST}/api/v1/events` (default host `https://cloud.ratel.sh`), best-effort in a background thread, so the dashboard fills with real per-interaction token data. You are **not** asking the customer to adopt Ratel's tool catalog or restructure their loop; instrumentation works with whatever they already have.

Two invariants hold throughout, and you should reassure the customer of both:

- **It never breaks their app.** Export is background, batched, and best-effort — it never blocks or raises into their code.
- **No key → no-op.** `get_client()` returns a singleton that silently does nothing until `RATEL_API_KEY` is set; you can add the calls now and turn ingestion on later.

## Procedure

### 1. Install and set the key

```bash
pip install 'ratel-ai'
export RATEL_API_KEY=rtl_...                  # the project ingest key from the dashboard
export RATEL_HOST=https://cloud.ratel.sh      # optional; this is the default
```

`RATEL_API_KEY` is the only required env var. Absent it, every call below is a no-op — safe to land in the customer's codebase before they have a key.

### 2. Find the per-interaction boundary

Locate the one place the customer calls the model per agent turn — the function that builds the prompt and invokes the LLM (e.g. `client.chat.completions.create(...)`, `anthropic.messages.create(...)`, an `agent.run(...)` step). That call site is where one `track()` goes. **One `track()` per agent interaction** — not per token, not per retry.

If their loop calls the model several times for one logical interaction (tool-use round-trips), pick the granularity that matches a dashboard "run": usually one `track()` per user turn, summing the tokens across the inner calls.

### 3. Add one `track()` per interaction

After the model call, attribute the prompt's tokens to the five context sources Ratel reports — **`skills`, `tools`, `history`, `memory`, `user_input`** — from whatever the customer already has, and ship the rollup:

```python
from ratel_ai import get_client

client = get_client()  # env-configured singleton; no-op without RATEL_API_KEY

# ... the customer's existing model call ...
response = chat.completions.create(model="claude-sonnet-4-6", messages=messages, ...)

client.track(
    tokens_by_category={
        "skills": skills_tokens,         # system/skill instructions, playbooks
        "tools": tools_tokens,           # tool / function definitions in the prompt
        "history": history_tokens,       # prior turns carried forward
        "memory": memory_tokens,         # retrieved memory / RAG context
        "user_input": user_input_tokens, # this turn's user message
    },
    model="claude-sonnet-4-6",
    output_tokens=response.usage.completion_tokens,
    latency_ms=elapsed_ms,               # optional
    cost_usd=None,                       # optional; auto-estimated from model + tokens if omitted
)
```

Mapping the customer's reality to the five sources:

- Map whatever they have to the closest source; **omit or zero a source they don't use** (a bare prompt-completion agent might only have `history` + `user_input`).
- Prefer **real token counts** when the provider already returns a per-segment breakdown or the customer tokenizes the prompt themselves.
- **No token counts? Approximate with `len(text) // 4`** — a serviceable chars-per-token estimate. The dashboard cares about proportions and trends, so a consistent estimate is fine:

  ```python
  def toks(text: str) -> int:
      return len(text) // 4

  tokens_by_category = {
      "skills": toks(system_prompt),
      "tools": toks(tools_json),
      "history": sum(toks(m["content"]) for m in prior_messages),
      "memory": toks(retrieved_context),
      "user_input": toks(user_message),
  }
  ```

Optional fields: `latency_ms`, `cost_usd` (auto-estimated from `model` + tokens when omitted), and `occurred_at` (a `datetime`; defaults to now server-side — pass it only when backfilling).

### 4. (Optional) Compute tool savings if they have a tool list

If the customer passes a list of tool/function definitions to the model, Ratel can measure what selection would keep **out** of the prompt. Build a `ToolCatalog(observe=True)`, register their tools once, and after each `search` read `cat.last_savings`:

```python
from ratel_ai import ToolCatalog, ExecutableTool

cat = ToolCatalog(observe=True)
for t in customer_tools:                 # register each of their tools once, at startup
    cat.register(ExecutableTool(
        id=t["name"], name=t["name"], description=t["description"],
        input_schema=t["parameters"], execute=lambda args: {},  # metadata-only is fine for sizing
    ))

# per interaction, before the model call:
cat.search(user_message, top_k=5)
# cat.last_savings → {"full_catalog_tokens", "selected_tokens", "tokens_saved", "top_k"}

client.track(
    tokens_by_category={...},
    saved_by_category={"tools": cat.last_savings["tokens_saved"]},  # if they act on selection
    model="claude-sonnet-4-6",
    output_tokens=response.usage.completion_tokens,
)
```

Two modes, pick the one that matches what the customer's loop actually does:

- **They send the selected top-K** to the model → feed the saving into `saved_by_category={"tools": cat.last_savings["tokens_saved"]}` (what Ratel kept out of the prompt this run).
- **Observe-only** — they still send the full catalog but want to know the upside → use `saveable_by_category={"tools": cat.last_savings["tokens_saved"]}` instead (what it *could* save).

Skip this step entirely if the customer has no tool list — `track()` with just `tokens_by_category` is a complete rollup.

### 5. Flush on shutdown

Rollups ship from a background thread. Drain it before the process exits so nothing is lost:

```python
client.flush()  # also auto-flushed at exit
```

`flush()` is auto-registered at interpreter exit, so an explicit call is belt-and-suspenders — add it to the customer's shutdown path (signal handler, `atexit`, web-server lifespan teardown, or the `finally` of a script) when the process may be killed before atexit runs.

## Conventions

- **Sources are exactly five**: `skills`, `tools`, `history`, `memory`, `user_input`. Don't invent new keys — unmapped context folds into the nearest of these.
- **One `track()` per interaction.** A "usage rollup" is per agent turn, not per provider call or per token.
- **Best-effort, never load-bearing.** Don't wrap `track()` in error handling that changes app behavior, and don't block the request path on it — the SDK already swallows failures and runs off-thread.
- **No key is a feature.** Landing the instrumentation before the customer has provisioned a key is fine and expected; it stays a no-op until `RATEL_API_KEY` is set.

## Why this exists

The lean observability layer and its `POST /api/v1/events` wire contract are recorded in [ADR 0016](../../../docs/adr/0016-lean-usage-rollups-rust-core.md) (which supersedes the earlier ADR 0013/0014 design). A runnable end-to-end demo — live skill/tool suggestions plus an SDK-driven "Ratel off → on" adoption story — lives at [`src/sdk/python/examples/observability_demo.py`](../../../src/sdk/python/examples/README.md).
