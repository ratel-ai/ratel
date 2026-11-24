# 9. Model calls go through one kit, and a deployment names its vendors

## Status

Proposed

## Context

The platform calls three kinds of model. Text models write names, labels, fix drafts and the
match-quality analysis, and replay a customer's agent in the eval gate. Decision models answer
closed-set questions: the match-quality judge, workflow decisions, topic placement. Embedding
models serve the Playground.

A self-hoster must be able to choose who serves each, a local server included, and a new feature
must work on every choice without extra effort. Ratel hosts the platform on Bedrock, and that path
must send the same requests as before. "No key, no outbound call" holds, and a mistyped setting
must not send customer data to the wrong place.

## Decision

**1. One kit, three contracts.** `lib/contracts/models.ts` declares `TextModel`, `ChatModel` (one
turn of a tool-using conversation) and `DecisionClient` (one closed-set choice). A feature asks
`models.text(feature)` or `models.chat(feature)`, and gets a decision through `judgeFromConfig`.
It names what it is, never a vendor or a model id. Embeddings keep `EmbeddingProviderPort`.

**2. The kit lives in `lib/readings/models/` (L4).** Its Claude adapter wraps
`lib/readings/anthropic/client.ts` and records spend through `lib/platform/model-call.ts`. Every
call site is at L4 or above.

**3. The setting is a vendor, not a wire format.** A customer knows which vendor they have an
account with. Vendors share an adapter where they share a format; the vendor tables
(`lib/readings/models/vendors.ts`, `lib/readings/decisions/vendors.ts`) know which.

| Kind | Setting | Values |
|---|---|---|
| Text and chat | `MODEL_PROVIDER` | unset (Claude, as `ANTHROPIC_BACKEND` and `ANTHROPIC_API_KEY` say), `claude`, `openai`, `gcp`, `bedrock`, `ollama`, `llama.cpp`, `vllm`, `litellm`, `custom`, `fake` |
| Decision | `DECISION_PROVIDER` | unset (OpenAI), `openai`, `typesafe`, `levanto`, `google`, `custom` |
| Embedding | `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | unset: OpenAI when keyed, else the local hash |

Every one is a setting of `web/src/config.ts`, chosen in the environment. There is no settings page.

**4. The selection is explicit and fails closed.** A named vendor is used or nothing is. An
unknown name selects nothing. A vendor is never inferred from a key. A vendor's key goes to that
vendor only: at another address only `MODEL_API_KEY` or `DECISION_API_KEY` is sent. Nothing
defaults to localhost, a cloud region or a worldwide endpoint, and no request follows a redirect.
`fake` works only in local environments. `DECISION_ENGINE` is the private edition's and selects
nothing in the core.

**5. Defaults per feature, and every one can be changed.** A feature's row asks for a tier (`deep`,
`standard` or `fast`), which is Ratel's own and not a setting.
On Claude each keeps its model (Opus 5.5, Sonnet 5.5, Haiku 5.5) and its own setting. A vendor that
serves Claude (`gcp`, `bedrock`) runs the same models; another hosted vendor has its nearest
equivalents; a server has none until one is named. `MODEL_FEATURE_<FEATURE>` names
one feature's model and `MODEL` every other's; one variable per tier was dropped, since a customer
knows Ratel's features and not its tiers.

**6. What a vendor lacks degrades.** Effort is sent where a model takes it. JSON is asked for by
schema, then as an object, then by prompt. A model that thinks gets at least 4,096 tokens, since
its thinking comes out of the same cap. A stop is returned, never thrown.

**7. Usage counts cached tokens inside input.** The Claude path keeps the accounting it has.

**8. A model without a price is charged at the fallback price**, so an unknown hosted model cannot
run past a budget. `MODEL_PRICES` is read first, and `0` is a price.

**9. Decision vendors are named.** `typesafe` (Jev), `levanto` (Sage) and `google` (Gemini
Decision) share one client; `custom` is any other System One server. Models are pinned. The hosted
embedding endpoint's vendor stays private.

**10. Thresholds belong to the vendor.** OpenAI's keeps its measured 0.8. Any other is held to 0.9
until `DECISION_MIN_CONFIDENCE` says it was measured.

**11. The eval gate keeps its Claude code**, wherever Claude is hosted, and has the same on any
other model (`models-neutral.ts`). Naming another vendor is enough to keep Claude out. A run
recorded on a model the vendor serves is replayed on it.

**12. The stand-ins stay.** `EVAL_GATE_MOCK_MODEL` and `MATCH_QUALITY_MOCK_ANALYST` keep their
behaviour and their precedence. `fake` is for the tests of adapters and new features.

## Consequences

- A self-hoster can run every model feature on one vendor of their choice, with no outbound call at
  all on a local server.
- A new feature is a prompt, a schema and a row in the feature table. Tests fail when code outside
  the adapters imports a vendor SDK, names a vendor's address, or calls with a feature that has no row.
- Quality is not portable: the prompts were tuned on Claude. The kit's README says which vendors
  were run live.
- A vendor's default models age. Each table carries the date it was checked.
- Google Cloud and Bedrock add `@anthropic-ai/vertex-sdk` and `google-auth-library`.
- Not covered: Tool Picker and the hosted `/v1/embeddings` in `ratel-platform`, a reranker or a
  plain LLM as the decision model, and vendor names for embeddings.
