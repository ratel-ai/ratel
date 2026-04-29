# 8. Tool selection — replace vs suggest

Date: 2026-04-29

## Status

Accepted

## Context

Ratel's tool-selection module has to inject its ranked top-K tool list into the agent's call to the LLM. Two postures are possible:

- **Replace:** the lib intercepts the tool list before the model call and *replaces* it with its ranked subset. Cleaner story; the agent sees only what Ratel selected.
- **Suggest:** the lib emits a ranked subset alongside the agent's existing tool list; the framework merges them (or doesn't). More compatible with framework-managed tools (memory, search, etc.) but the agent can ignore Ratel's ranking.

The right answer depends on what each TS agent framework actually allows at its tool-injection seam. See `docs/RATEL_V1_PLAN.md` §6.2 and `docs/RATEL_PHASE_0.md` §6.2 for the framing.

Phase 0 verification (April 2026 sources):

- **Vercel AI SDK** (`ai` package, v6+): tools are passed as the `tools` parameter to `generateText` / `streamText` / `agent()`. Object mapping from tool name → `tool()` instance. No framework-injected tools observed in the API surface; the consumer's `tools` object is the complete set sent to the model.
- **OpenAI Agents SDK** (`@openai/agents`): public docs surface this less clearly. The `Agent` constructor takes `tools`, but framework-managed tools (handoffs, computer-use, etc.) are added by the SDK itself depending on configuration. Replace-vs-suggest cannot be confirmed at the file/symbol level from public docs alone — needs a code-spike at integration time.
- **Anthropic SDK** (`@anthropic-ai/sdk`): the `tools` parameter on `messages.create` / `messages.stream` is a passthrough to the API. The SDK injects nothing. Cleanest possible replace point.
- **LangChain.js** (`@langchain/core` / `langchain`): two API styles. (a) Direct `model.bindTools(tools)` is a clean replace point on the model wrapper. (b) Agent abstractions (`createAgent`, ReAct agents, middleware) may augment the tool list with framework-managed loops/tools (e.g., structured-output-via-tools mode conflicts with explicit `bindTools`). Replace at the bound-model level; cannot guarantee replace at the agent-graph level without integration-specific shims.

## Decision

**Configurable per-framework, defaulting to *replace* where the framework allows it cleanly, *suggest* (or middleware) otherwise.**

The lib exposes both modes at the public API:

- `mode: "replace"` — the default. Ratel's ranked subset is the tool list the model sees. The framework integration is responsible for wiring this to the framework's actual tool-injection seam.
- `mode: "suggest"` — Ratel emits the ranked subset as metadata; the framework integration merges with the consumer's existing tools, putting Ratel's picks first.

**Framework-by-framework default position** (subject to confirmation as each integration ships):

| Framework             | Default mode | Where the integration hooks                                          |
| --------------------- | ------------ | -------------------------------------------------------------------- |
| Vercel AI SDK         | `replace`    | At the `tools` parameter of `generateText`/`streamText`              |
| Anthropic SDK         | `replace`    | At the `tools` parameter of `messages.create`/`messages.stream`      |
| OpenAI Agents SDK     | `suggest`    | (Pending integration-time code spike to confirm whether replace is reachable) |
| LangChain.js (model)  | `replace`    | At `model.bindTools()`                                               |
| LangChain.js (agent)  | `suggest`    | Middleware that runs before the agent graph dispatches to the model  |

Phase 2 ships Vercel AI SDK and Anthropic SDK as the v1 default integrations (both clean replace). The other frameworks are deferred to v1.1 `integrations/` work and will revisit this matrix at integration time.

## Consequences

- The two modes are exposed as a single public-API enum; no framework-by-framework branching in user code. Framework integrations carry the wiring responsibility.
- The "replace" default sells the cleanest story in the demo (RATEL_V1_PLAN.md §7 builder demo, step 2): "one Ratel import → tools auto-ranked top-8."
- The "suggest" mode exists for compatibility but isn't shown in the headline demo — it's the fallback when a framework forces it.
- OpenAI Agents SDK and LangChain agent-graph integrations need a follow-up code spike before their respective `integrations/` ship. Tracked as Phase 1.x / v1.1 work.
- If a framework turns out to allow neither cleanly (i.e., bakes the tool list into a prompt template that the integration can't intercept), we land at "suggest" + a documented compatibility limitation. Cost: low, per RATEL_PHASE_0.md §8 risk note.
