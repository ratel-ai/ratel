# `lib/readings/models` (L4): the model kit

Where a feature gets a model, whoever serves it
([ADR-0033](../../../../../docs/adr/0033-platform-provider-neutral-model-kit.md)). A feature
names what it is and gets the deployment's model for it, or `null` when the deployment has none.
It never names a provider or a model id, and it never imports a vendor SDK.

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
4. Test it with `MODEL_PROVIDER=fake` (pass `{ env, environment: "test" }`), or hand your code a
   `fakeTextModel({ reply })` from `fake.ts`. Neither calls out.

Ask for the weakest tier that does the job. Do not send `effort` unless the feature needs it: it
is dropped where a model does not take it.

## Files

| File | What it holds |
|---|---|
| `index.ts` | `models.text`, `models.chat`, `modelsConfigured`; the provider registry (`withProviders`) |
| `config.ts` | Which provider the environment selects, and the model id for a feature on it |
| `features.ts` | The table of every feature that calls a model |
| `prices.ts` | What a call counts against a budget: `MODEL_PRICES`, then Ratel's rates, then the fallback |
| `fake.ts` | The fake provider: fixed answers, no network |

The contracts (`TextModel`, `ChatModel`, `DecisionClient`) are in `lib/contracts/models.ts`.

## Choosing a provider

| Variable | Meaning |
|---|---|
| `MODEL_PROVIDER` | Unset or `anthropic`: Claude, as `ANTHROPIC_BACKEND` and `ANTHROPIC_API_KEY` decide. `openai-compatible`: any chat completions server. `fake`: local environments only. Anything else: no model |
| `MODEL_BASE_URL`, `MODEL_API_KEY` | The `openai-compatible` server. The URL is required; the key is not (a local server) |
| `MODEL_DEEP`, `MODEL_STANDARD`, `MODEL_FAST` | The model per tier on a provider other than Claude. A tier without one uses `MODEL_STANDARD` |
| `MODEL_MAX_OUTPUT_TOKENS` | The most any call may ask a model to generate |
| `MODEL_PRICES` | JSON of model id to `{ "input", "output", "cachedInput"? }` in dollars per million tokens. `0` is a price |

On Claude each feature keeps its own variable and default (the `variables` and `claudeDefault`
columns of `features.ts`); the tier variables never move a Claude deployment.

The selection fails closed: a named provider never falls back to another, the provider is never
inferred from `OPENAI_API_KEY`, and nothing defaults to localhost.
`no-outbound-without-key.test.ts` holds the table.

## Providers

| Provider | File | Notes |
|---|---|---|
| Claude (unset, or `anthropic`) | `providers/anthropic.ts` | Over `readings/anthropic/client.ts`: the Anthropic API, or Bedrock through EU profiles. Text only; the eval gate's Claude agent is still its own |
| `openai-compatible` | `providers/openai-compatible.ts` | Chat completions over `fetch`: OpenAI, Gemini's compatible endpoint, vLLM, llama.cpp, Ollama. Text and tool calls |
| `fake` | `fake.ts` | Local environments only |

`openai-compatible` asks for the most a server can do and steps down. JSON output is asked for by
schema, then as a JSON object, then by the prompt alone; what a server took is remembered. A model
named in `MODEL_REASONING_MODELS` (comma-separated id prefixes, such as `o4,gpt-5`) is sent
`max_completion_tokens` and its effort and no temperature; every other model gets `max_tokens`.
Usage a server does not report is estimated. One call, with its retries, is one spend line.

`pnpm --filter @ratel/platform models:smoke` runs a plain answer, a schema-bound answer, a
streamed answer and a tool call against whatever the environment selects. Checked live on Ollama
(`llama3.2:1b`, `qwen2.5:0.5b`) and on llama.cpp's `llama-server` (started with `--jinja`, which
its tool calls need).

## Status

| Feature | On the kit |
|---|---|
| Workflow labels, intent names, topic names, fix drafts, the match-quality analyst | yes |
| Eval gate (replay, judge, tool stand-in, person, test draft) | not yet |
| Decisions | in `readings/decisions`, not behind `models`: `DECISION_ENGINE` picks OpenAI's Decisions API or `system-one`, and `judgeFromEnv` builds every surface's judge. A reranker and an LLM as the judge are not built yet |

`call-sites.test.ts` runs the moved features on a model that is not Claude. The golden tests
beside each site (`*.golden.test.ts`) hold the Claude path to the requests it sent before the kit.
