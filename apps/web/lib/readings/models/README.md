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

## Status

The registry holds the fake provider. The Claude and `openai-compatible` adapters land in
`providers/`, and the call sites move onto the kit after them (ADR-0033).
