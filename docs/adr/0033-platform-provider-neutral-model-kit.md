# 33. Ratel Platform: model calls go through a provider-neutral kit

Date: 2026-11-20

## Status

Proposed

Builds on [ADR-0030](0030-platform-oss-layered-core-and-cloud-sync.md): the kit and its adapters
are owned here; the Claude client it wraps stays copied from `ratel-cloud`.

## Context

The platform calls three kinds of model. Text models write names, labels, fix drafts and the
match-quality analysis, and replay a customer's agent in the eval gate. Decision models answer
closed-set questions (which of these options fits, and how surely): the match-quality judge,
workflow decisions, topic placement. Embedding models serve the Playground.

Every text call is Claude, on the Anthropic API or on Amazon Bedrock through EU inference
profiles, and each call site builds Anthropic's request shape itself. Every decision call is
OpenAI's Decisions API. One pair of variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`) turns on both
decisions and embeddings. A self-hoster cannot choose another provider or a local server, and a
new feature has no way to call a model that is not tied to one vendor.

Three things constrain a change:

- Ratel hosts the platform on Bedrock. That path must send the same requests as before.
- `ratel-cloud` is still synced in. A `copy` file may not be edited, and `copy` consumers and
  tests pin the exported names of `views/eval-gate/models.ts`, `synthesis/match-quality/analyst.ts`
  and `readings/intent-engine/names-job.ts`.
- "No key, no outbound call" holds today, and a mistyped setting gives no client, so a typo
  cannot send customer data to the wrong place.

## Decision

**1. One kit, three contracts.** `lib/contracts/models.ts` declares `TextModel` (system and user
in, text out, optionally bound to a JSON schema), `ChatModel` (one turn of a tool-using
conversation) and `DecisionClient` (one closed-set choice, with the engine's capabilities). The
kit in `lib/readings/models/` resolves them from the environment: `models.text(feature)`,
`models.chat(feature)`, `models.decision(feature)`. A feature names what it is; it never names a
provider or a model id. Embeddings keep `EmbeddingProviderPort`.

**2. The kit lives in `lib/readings/models/`.** Its Claude adapter wraps
`lib/readings/anthropic/client.ts`, which is a `copy` file at layer 4, and it records spend
through `lib/platform/model-call.ts`. Every call site is at layer 4 or above. `lib/adapters/` is
layer 0 and cannot record spend; `lib/platform/` is layer 1 and cannot import the Claude client.

**3. Unset means today.** With none of the new variables set, text calls go to Claude exactly as
`ANTHROPIC_BACKEND` and `ANTHROPIC_API_KEY` decide now, decisions go to OpenAI's Decisions API,
and embeddings follow `OPENAI_API_KEY`.

| Kind | Variables | Values |
|---|---|---|
| Text and chat | `MODEL_PROVIDER`, `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_DEEP`, `MODEL_STANDARD`, `MODEL_FAST`, `MODEL_MAX_OUTPUT_TOKENS`, `MODEL_REASONING_MODELS`, `MODEL_PRICES` | unset (Claude, as today), `anthropic-vertex`, `anthropic-bedrock`, `openai-compatible`, `fake` |
| Decision | `DECISION_ENGINE`, `DECISION_BASE_URL`, `DECISION_API_KEY`, `DECISION_MODEL`, `DECISION_MIN_CONFIDENCE` | `openai` (default), `system-one`; `rerank` and `llm` are planned |
| Embedding | `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | fall back to `OPENAI_*`, then the local hash |

`openai-compatible` is any server that speaks chat completions: OpenAI, Gemini's compatible
endpoint, vLLM, llama.cpp, Ollama. The adapters are written over `fetch`; no vendor SDK is added.

**4. The selection is explicit and fails closed.** An unknown `MODEL_PROVIDER` gives no client.
An unknown `DECISION_ENGINE` is the one exception: it is read as `openai` with a warning, as
before, because Ratel's own deployments set the names of the Cloud edition's private engines
there and the core must keep judging. A key goes only to the server it was set for: the OpenAI
key is never sent to `DECISION_BASE_URL` or `EMBEDDING_BASE_URL`. The text
provider is never inferred from `OPENAI_API_KEY`, which Ratel sets for decisions. A server
without a key counts as configured only when its base URL is set; nothing defaults to localhost.
`fake` works only in local environments.

**5. Tiers, not model ids.** A feature asks for `deep`, `standard` or `fast`. On Claude each
feature keeps its present default and its present variable (`ANTHROPIC_MODEL`,
`TRACE_WORKFLOW_LABEL_MODEL`, `TOPICS_LABEL_MODEL`, `INTENT_ENGINE_NAME_MODEL`,
`EVAL_GATE_REPLAY_MODEL`, `EVAL_GATE_JUDGE_MODEL`, `EVAL_GATE_DRAFT_MODEL`). On another provider
`MODEL_DEEP`, `MODEL_STANDARD` and `MODEL_FAST` name the models. One flat table lists every
feature with its kind, tier and variable; a test fails when a call names a feature that is not in it.

**6. What a provider lacks degrades silently.** Effort is sent where the model takes it and
dropped elsewhere. JSON output is asked for by schema, then as a JSON object, then by prompt
alone. A stop is returned, never thrown: `end`, `cut_off` or `refused`, and each feature keeps its
own error for it.

**7. Usage counts cached tokens inside input.** That is what the price book assumes. The Claude
path keeps the accounting it has.

**8. A model without a price is charged at the fallback price.** A budget can then never be
bypassed by an unknown hosted model. `MODEL_PRICES` (JSON, model id to input and output price in
dollars per million tokens) is read first, and `0` is allowed for a local model.

**9. System One ships as a format, not a vendor.** The `system-one` engine speaks the System One
wire format (`POST /v1/systemone`) and is configured by base URL, model and key alone, so a
self-hoster can point it at any server that speaks it. No vendor name, default URL or key variable
enters `apps/web`, and `check:private` is unchanged. This amends the note in
`lib/readings/decisions/engine.ts` that the other engines are private: vendor defaults and
calibration stay private, the format is open.

**10. Confidence thresholds belong to the engine.** Each engine declares whether it refuses,
whether its confidence is calibrated, a score, or absent, and how many options it takes. The judge
reads the thresholds of the engine it runs on: OpenAI's keeps its measured 0.8, and an engine
whose confidence is only a score is held to 0.9 until `DECISION_MIN_CONFIDENCE` says it was
measured. An engine is trusted for a surface only after the judge benchmark has run on it.

**11. The eval gate gains a branch; the Claude branch is not rewritten.** `resolveEvalModels`
and its siblings choose by provider. Everything exported from `views/eval-gate/models.ts` stays.

**12. One file leaves the sync.** `lib/synthesis/match-quality/job.ts` becomes `owned`: its
`resolveAnalystFactory` asks whether Claude is configured, and no other provider could be chosen
without changing it.

**13. The stand-ins stay.** `EVAL_GATE_MOCK_MODEL` and `MATCH_QUALITY_MOCK_ANALYST` keep their
behaviour and their precedence. The `fake` provider is separate: it serves the adapters'
conformance tests and new features' tests.

## Consequences

- A self-hoster can run every model feature on one provider of their choice, including a local
  server with no outbound call at all.
- A new feature is a prompt, a schema and a row in the feature table. A guard test fails when
  code outside the adapters imports a vendor SDK or names a model host.
- Quality is not portable. The prompts were tuned on Claude; a weaker model writes weaker fixes.
  The docs name which providers Ratel has tested.
- The tool-calling translation for OpenAI-compatible servers is ours to maintain, and local
  servers differ in how well they follow it.
- The platform does not reuse the SDK's ranker plugins (ADR-0028). They return ids and scores
  only, without token usage, framing or retries, and the platform pins an SDK below their floor.
  The two align on wire formats and variable names.
- Not covered here: Tool Picker and the hosted `/v1/embeddings` in `ratel-platform`, Bedrock's
  Converse API for models other than Claude, a Bedrock embeddings adapter, and a hook for an
  edition to register private engines.
- When `ratel-cloud` is retired, the Claude branch of the eval gate can fold into `ChatModel`.
