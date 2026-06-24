# 15. Transparent provider-call tool selection

Date: 2026-06-24

## Status

Accepted

## Context

The observability wrappers (ADR-0013) sit directly on the provider call path —
`openai.chat.completions.create`, `anthropic.messages.create`. A caller that has
adopted them passes their full `tools=[...]` array to the model on every turn.
That is exactly the waste Ratel's tool-selection thesis targets (ADR-0003): a
large tool list burns input tokens and degrades selection quality.

Ratel's `ToolCatalog` already solves this, but it requires the caller to register
their tools and route dispatch through Ratel. The wrapper gives us a second,
zero-registration place to deliver the same value: rank the tools the caller
*already passed* and keep only the top-K before the call leaves the process.

The catch: unlike everything else in the observability layer, this **changes what
the model can do**. If we drop a tool the model needed and there's no gateway
escape hatch (the caller isn't using `ToolCatalog`/`search_capabilities`), the
agent simply can't call it. So the safety bar is higher than for passive tracing.

## Decision

Add an **opt-in** transparent tool-selection mode to the provider wrappers
(`wrap_openai(client, select_tools=...)`, `OpenAI(select_tools=...)`, and the
`anthropic` equivalents; env `RATEL_TOOL_SELECTION`). When enabled, before each
call the wrapper ranks the request's `tools` with the **same native BM25
`ToolRegistry`** the explicit catalog uses, keyed by the latest user-message
text, and replaces the array with the top-K.

Safety properties, all enforced in `ratel_ai/integrations/selection.py`:

- **Off by default.** Plain `from ratel_ai.openai import OpenAI` stays pure,
  non-behavior-changing observability. Selection is a separate explicit opt-in.
- **Threshold-gated.** Only prunes when the tool count exceeds `min_tools`
  (default 25); small lists aren't worth the behavior change. Keeps a `top_k`
  working set (default 20), both tunable per call or via env.
- **`tool_choice` is pinned.** A tool the request forces/names always survives.
- **Unreadable tools are kept.** Provider built-ins (no function name / schema)
  are never ranked out.
- **Never prunes to nothing.** If the query matches no tool, or nothing would be
  trimmed, the original array is used unchanged.
- **Fails open.** Any error in ranking → the original `tools` are passed through.
  This inherits the layer-wide rule: never break the caller's call.
- **Independent of export.** Pruning is pure local token savings — it works with
  no `RATEL_API_KEY` (the customer saves provider tokens even if nothing ships to
  the cloud). The saving is *reported* as a `ratel.tokens_saved` event (the same
  event the catalog emits) plus an annotation on the generation observation
  (`tools_offered` / `tools_selected` / `selected_tools`), so it's no-op without a
  key but the savings still happen.

The estimator and savings math reuse `observability/savings.py` and
`estimator.py`; savings is measured over the JSON footprint of the offered vs.
kept tool dicts.

## Consequences

- A caller adopts Ratel's context engineering by changing **one import and adding
  one flag** — no `ToolCatalog`, no dispatch changes. The wrapper becomes both the
  analytics hook and the selection delivery mechanism.
- The explicit `ToolCatalog` / `search_capabilities` path remains the
  higher-control option for teams that want the gateway escape hatch, skills, and
  full dispatch instrumentation. The two share one ranking engine.
- The cloud sees one uniform `ratel.tokens_saved` event type regardless of which
  path produced the saving.
- Because pruning has no gateway fallback in this mode, conservative defaults
  (high `min_tools`, generous `top_k`) bias toward correctness over maximal
  savings; teams dial `top_k` down as they gain confidence.

## Rejected

- **On by default.** Silently changing which tools a model can call is the kind of
  surprise that erodes trust; behavior changes must be opted into.
- **A separate selection-only wrapper.** Folding selection into the existing
  traced wrapper keeps one call-path interception point and one place that must
  honor the never-break-the-call rule.
- **Ranking on the full conversation.** The latest user turn is the immediate
  intent and keeps the query focused; richer query construction can come later
  without changing the contract.
- **Client-side gateway injection** (auto-adding `search_capabilities`/
  `invoke_tool` so the model can recover a pruned tool). Powerful but it reshapes
  the caller's tool list and loop semantics far more invasively than a prune;
  left to the explicit `ToolCatalog` path.
