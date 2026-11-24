# `lib/readings/models` (L4): the model kit

Where a feature gets a model, whoever serves it
([ADR-0009](../../../../../docs/adr/0009-model-vendors.md)). A feature
names what it is and gets the deployment's model for it, or `null` when the deployment has none.
It never names a vendor or a model id, and it never imports a vendor SDK.

```ts
import { models } from "@/lib/readings/models";

const model = models.text("workflow_label");
if (!model) return null; // not available here: report it, as without a key
const reply = await model.complete({ system, user, schema: LABEL_SCHEMA, maxTokens: 400 });
if (reply.stop === "cut_off") throw new LabelCutOffError();
```

## Adding a feature that calls a model

1. Add a row to `features.ts`: its id (the name its spend line carries), its kind (`text`,
   `chat` for tool calls, `decision`), its tier (`deep`, `standard`, `fast`) and one line on what
   it does. `features.test.ts` fails when a call names a feature that has no row.
2. Ask the kit: `models.text(id)` or `models.chat(id)`. Handle `null`.
3. Read `reply.stop`. A stop is returned, never thrown: `end`, `cut_off` (ran out of `maxTokens`)
   or `refused`.
4. Test it with `MODEL_PROVIDER=fake` (pass `{ config: resolveConfig({ env: { MODEL_PROVIDER: "fake" } }), environment: "test" }`), or hand your code a
   `fakeTextModel({ reply })` from `fake.ts`. Neither calls out.

Ask for the weakest tier that does the job. Do not send `effort` unless the feature needs it: it
is dropped where a model does not take it.

## Adding a vendor

A row in `vendors.ts` (its address, its key variable, a model per tier) and a line in
`providers/index.ts` naming the adapter that speaks its format. What it does its own way is a
`Dialect`. Add it to `providers/vendors.test.ts`: from its variables to the request on the wire.

## Files

| File | What it holds |
|---|---|
| `index.ts` | `models.text`, `models.chat`; `claudeFor`, the Claude client the eval gate's Claude code calls with; `modelsConfigured` |
| `vendors.ts` | Every vendor: its address, its key variable, its model per tier |
| `config.ts` | Which vendor the environment selects, and the model id for a feature on it. The one place that reads a setting to choose a vendor |
| `features.ts` | The table of every feature that calls a model |
| `prices.ts` | What a call counts against a budget: `MODEL_PRICES`, the vendors' list prices, Ratel's rates, the fallback |
| `fake.ts` | The fake vendor: fixed answers, no network |
| `providers/index.ts` | Which adapter serves each vendor |
| `providers/anthropic.ts`, `claude-hosts.ts` | Claude: Anthropic's API or Ratel's Bedrock through `readings/anthropic/client.ts`; Vertex AI and Bedrock as vendors |
| `providers/responses.ts` | The Responses API: OpenAI |
| `providers/chat-completions.ts` | Chat completions: Gemini on Vertex AI, the other models on Bedrock, every server |
| `providers/http.ts`, `cloud-auth.ts` | The request with its retries; the Google and AWS logins |
| `explain.ts` | What a self-hoster reads when models do not work (ADR-0009 §13): each kind's setup or why it is off, and one sentence per failed call naming the setting to fix. Never a key or a provider's words |
| `status.ts`, `schema.ts` | At boot (open-source edition): the setup in the log, then each failed call logged and kept per feature in `model_failures` for Organization settings > Models |

The contracts (`TextModel`, `ChatModel`, `DecisionClient`) are in `lib/contracts/models.ts`.

## Vendors

| `MODEL_PROVIDER` | Needs | Deep · standard · fast | Run live |
|---|---|---|---|
| unset, `claude` | `ANTHROPIC_API_KEY`, or `ANTHROPIC_BACKEND` | `claude-opus-5-5` · `claude-sonnet-5-5` · `claude-haiku-5-5` | all three, on the Anthropic API |
| `openai` | `OPENAI_API_KEY` | `gpt-6.2-astra` · `gpt-6.2-sol` · `gpt-6-luna` | all three |
| `gcp` | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, the Google login | as Claude, or a Gemini model by name | in `eu`: `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-3.5-flash-lite` and all three Claude models |
| `bedrock` | `AWS_REGION`, the AWS login or `AWS_BEARER_TOKEN_BEDROCK` | as Claude, or another Bedrock model by name | `openai.gpt-oss-120b-1:0`, `qwen.qwen3-32b-v1:0`; all three Claude models in `eu-central-1`, with an AWS login on an account that has Claude access |
| `ollama` | `MODEL_BASE_URL` | name one | `llama3.2:1b`, `qwen2.5:0.5b` |
| `llama.cpp` | `MODEL_BASE_URL`; start it with `--jinja` for tools | name one | `qwen2.5:0.5b` |
| `litellm` | `MODEL_BASE_URL`, usually `MODEL_API_KEY` | name one | v1.110.2, over `llama3.2:1b` and `qwen2.5:0.5b` |
| `custom` | `MODEL_BASE_URL` with its path | name one | `qwen2.5:0.5b` |

The model of a feature, in order: `MODEL_FEATURE_<FEATURE>` (its id in capitals); on a vendor that
serves Claude, the feature's own settings (the `settings` column of `features.ts`); `MODEL`; the
vendor's model for the feature's tier. The tier (deep, standard or fast) is Ratel's own and not a
setting. A server has no models of its own, so it needs `MODEL`, or a feature's own for that one.

`MODEL_API_KEY` is ahead of a vendor's own key variable, and the only key sent to a
`MODEL_BASE_URL`. `MODEL_MAX_OUTPUT_TOKENS` caps any call. `MODEL_PRICES` is JSON of model id to
`{ "input", "output", "cachedInput"? }` in dollars per million tokens, where `0` is a price.

The selection fails closed: a named vendor never falls back to another, a vendor is never inferred
from a key, and nothing defaults to localhost. `no-outbound-without-key.test.ts` holds the table.

On Google Cloud an organization allows a partner model's features one by one
(`constraints/vertexai.allowedPartnerModelFeatures`). Where it forbids `structured_outputs`, Claude
is asked for its JSON in words, and the refusal is remembered for that project and model.

What the adapters do where vendors differ: chat completions asks for JSON by schema, then as a JSON
object, then by the prompt alone, stepping down when a server refuses the format or ignores it, and
remembers what a server took. A feature gets the JSON alone, and an answer without the thinking some
servers write in front of it. A model that thinks (the
vendor's, or one named in `MODEL_REASONING_MODELS`) gets its effort and at least 4,096 tokens, since
its thinking comes out of the same cap. The Responses API is asked to store nothing. Usage a server
does not report is estimated. One call, with its retries, is one spend line.

`pnpm --filter @ratel/platform models:smoke` runs a plain answer, a schema-bound answer, a streamed
answer, a tool call, a decision and, with `EMBEDDING_*` set, embeddings, against whatever the
environment selects.

## Tests that hold it

`call-sites.test.ts` runs the features on a model that is not Claude, and
`views/eval-gate/models-neutral.test.ts` the eval gate. The golden tests beside each site
(`*.golden.test.ts`) hold the Claude path to the requests it sent before the kit. Decisions are in
`readings/decisions` (`vendors.ts`, `DECISION_PROVIDER`); OpenAI, Levanto (Sage 2),
TypeSafe (Jev 1.14) and Google (Gemini Decision 1) were run live, and `custom` against Sage. A reranker or an LLM as the judge is not built.
