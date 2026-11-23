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
`models.chat(feature)`; decisions are resolved beside their judge, in `lib/readings/decisions/`. A
feature names what it is; it never names a vendor or a model id. Embeddings keep `EmbeddingProviderPort`.

**2. The kit lives in `lib/readings/models/`.** Its Claude adapter wraps
`lib/readings/anthropic/client.ts`, which is a `copy` file at layer 4, and it records spend
through `lib/platform/model-call.ts`. Every call site is at layer 4 or above. `lib/adapters/` is
layer 0 and cannot record spend; `lib/platform/` is layer 1 and cannot import the Claude client.

**3. Unset means today.** With none of the new variables set, text calls go to Claude exactly as
`ANTHROPIC_BACKEND` and `ANTHROPIC_API_KEY` decide now, decisions go to OpenAI's Decisions API,
and embeddings follow `OPENAI_API_KEY`.

| Kind | Variables | Values |
|---|---|---|
| Text and chat | `MODEL_PROVIDER` | unset (Claude, as today), `claude`, `openai`, `mistral`, `grok`, `gcp`, `bedrock`, `ollama`, `llama.cpp`, `vllm`, `litellm`, `custom`, `fake` |
| Decision | `DECISION_PROVIDER` | unset (OpenAI, as today), `openai`, `typesafe`, `levanto`, `google`, `custom` |
| Embedding | `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | fall back to `OPENAI_*`, then the local hash |

**The setting is a vendor, not a wire format.** A self-hoster knows which vendor they have an
account with; which API it speaks is the vendor table's business (`lib/readings/models/vendors.ts`,
`lib/readings/decisions/vendors.ts`). A hosted vendor takes its own key variable or cloud login and
nothing else. A server the customer runs takes its address. Vendors share an adapter where they
share a format: Claude's own (Anthropic, Vertex AI, Bedrock), the Responses API (OpenAI, Grok),
chat completions (Mistral, Gemini on Vertex AI, the other models on Bedrock, every server), and the
System One family for decisions. Vendors are chosen in the environment; there is no settings page.

**4. The selection is explicit and fails closed.** A named vendor is used or nothing is. A name
that is not in the table selects nothing. A vendor is never inferred from a key. A vendor's key is
sent to that vendor only: at another address (`MODEL_BASE_URL`, `DECISION_BASE_URL`) only
`MODEL_API_KEY` or `DECISION_API_KEY` is. Nothing defaults to localhost, to a cloud region or to a
worldwide endpoint, and no request follows a redirect. `fake` works only in local environments.
`DECISION_ENGINE`, which Ratel's own deployments set for the private edition's calls, selects
nothing in the core.

**5. Tiers, not model ids, and every default can be changed.** A feature asks for `deep`,
`standard` or `fast`. On Claude each feature keeps its present model (Opus 5.5, Sonnet 5.5, Haiku
5.5) and its present variable (`ANTHROPIC_MODEL`, `TRACE_WORKFLOW_LABEL_MODEL`,
`TOPICS_LABEL_MODEL`, `INTENT_ENGINE_NAME_MODEL`, `EVAL_GATE_REPLAY_MODEL`,
`EVAL_GATE_JUDGE_MODEL`, `EVAL_GATE_DRAFT_MODEL`). A vendor that serves Claude (`gcp`, `bedrock`)
runs the same models. Another hosted vendor has its nearest equivalent per tier, never a weaker one
where the choice is between two; a server has none until one is named. `MODEL_DEEP`,
`MODEL_STANDARD` and `MODEL_FAST` change a tier on any vendor and `MODEL_FEATURE_<FEATURE>` changes
one feature. One flat table lists every feature; a test fails when a call names one that is not in it.

**6. What a provider lacks degrades silently.** Effort is sent where the model takes it and
dropped elsewhere. A model that thinks spends its token cap on thinking first, so a small cap is
raised to 4,096 and, with no effort asked for, thinking is kept low. JSON output is asked for by schema, then as a JSON object, then by prompt
alone. A stop is returned, never thrown: `end`, `cut_off` or `refused`, and each feature keeps its
own error for it.

**7. Usage counts cached tokens inside input.** That is what the price book assumes. The Claude
path keeps the accounting it has.

**8. A model without a price is charged at the fallback price.** A budget can then never be
bypassed by an unknown hosted model. `MODEL_PRICES` (JSON, model id to input and output price in
dollars per million tokens) is read first, and `0` is allowed for a local model; then the vendors'
list prices.

**9. Decision vendors are named too.** `typesafe` (Jev), `levanto` (Sage) and `google` (Gemini
Decision) share one client, because their formats differ by a path, a header and a field name;
`custom` is any other server that speaks System One. Their names, addresses and key variables are in
the open code, so `private-strings.txt` no longer lists them; the hosted embedding endpoint's vendor
stays listed. Models are pinned. Google's Decisions API is on the Gemini Developer API only, so it
takes a Gemini key and not the Google Cloud login.

**10. Confidence thresholds belong to the engine.** Each engine declares whether it refuses,
whether its confidence is calibrated, a score, or absent, and how many options it takes. The judge
reads the thresholds of the engine it runs on: OpenAI's keeps its measured 0.8, and an engine
whose confidence is only a score is held to 0.9 until `DECISION_MIN_CONFIDENCE` says it was
measured. An engine is trusted for a surface only after the judge benchmark has run on it.

**11. The eval gate gains a branch; the Claude branch is not rewritten.** `resolveEvalModels`
and its siblings ask the kit who answers: a Claude model, wherever it is hosted, through the code
that was there; any other through `models-neutral.ts`. Everything exported from
`views/eval-gate/models.ts` stays. Naming another vendor is enough to keep Claude out, even with a
Claude key present. A run recorded on a model the vendor serves is replayed on it.

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
- The tool-calling translation for each format is ours to maintain, and local
  servers differ in how well they follow it.
- The platform does not reuse the SDK's ranker plugins (ADR-0028). They return ids and scores
  only, without token usage, framing or retries, and the platform pins an SDK below their floor.
  The two align on wire formats and variable names.
- A vendor's default models age. They are in one table per kind, with the date they were checked.
- Google Cloud and Bedrock add two dependencies (`@anthropic-ai/vertex-sdk`,
  `google-auth-library`); the vendor SDKs stay inside the adapters.
- Not covered here: Tool Picker and the hosted `/v1/embeddings` in `ratel-platform`, a reranker or
  a plain LLM as the decision engine, and vendor settings for embeddings.
- When `ratel-cloud` is retired, the Claude branch of the eval gate can fold into `ChatModel`.
