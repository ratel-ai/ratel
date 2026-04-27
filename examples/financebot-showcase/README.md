# FinanceBot showcase

A real, runnable demo of Agentified's leverage story. The same canned task — *"investigate anomalous transactions in the last 7 days, gather supporting context, and email a CFO memo"* — is run twice against a real LLM and real tool execution:

1. **Raw mode**: all 100 tool schemas exposed to the model on every step.
2. **Agentified mode**: only `agentified_discover` is active to start; the model discovers the right atoms, `prepareStep` activates them, and the rest stay hidden.

Both runs use the same model, the same prompt, and the same tool implementations — so the gap between them is purely the leverage Agentified provides.

## Numbers from a real run (gpt-4o-mini, April 2026)

|                       | Raw 100 tools | Agentified-curated |
| --------------------- | ------------- | ------------------ |
| Tools loaded          | 100           | 6                  |
| Input tokens          | ~60,000       | ~12,000 (5× less)  |
| Output tokens         | ~900          | ~1,500             |
| Estimated cost        | $0.0096       | $0.0027 (3.5× less)|
| Tool calls            | 20            | 6                  |
| Reliability           | 60%           | 100%               |
| Wall clock            | ~47 s         | ~37 s              |
| Final memo produced?  | no — ran out of steps re-trying wrong-arg `crm_get_contact` calls | yes — full structured memo |

Numbers vary run-to-run (LLMs are non-deterministic). The qualitative picture stays: **5× input-token reduction, 3–4× lower cost, far higher reliability, and a memo that actually gets written.**

## What's real vs simulated

**Real** (every demo run hits the live core + real LLM):
- 100 tool registrations and 5 skill registrations against `agentified-core`.
- The agent loop — driven by `gpt-4o-mini` via the AI SDK — actually calls tools and reads responses.
- All metrics in the recordings: `input_tokens`, `output_tokens`, `tool_calls`, `wall_clock_seconds`, `reliability_score`, `estimated_cost_usd` (priced at gpt-4o-mini's $0.15/$0.60 per 1M).
- The CFO memo content in `final_text` is what the model produced in that run.

**Simulated** (so we don't need a real ledger):
- Tool *handlers* return deterministic fixtures from `src/fixtures.ts`. The 10 tools the anomaly-investigation task uses (`ledger_list_transactions`, `ledger_detect_anomalies`, `crm_get_contact`, `docs_search_policy`, `docs_draft_memo`, `comms_send_email`, etc.) return realistic shapes — 18 transactions including 3 plausible anomalies (round-number $50k payment to a brand-new vendor with missing KYC, lookalike vendor name, marketing prepay over the policy threshold), vendor profiles, and AP policy snippets. The other ~90 tools stay as `{ok: true, args}` stubs — they exist purely to inflate the registered surface so the "raw 100 tools" baseline is honest.

## Layout

```
src/
  fixtures.ts     Deterministic FinanceBot data (transactions, contacts, policies)
  tools.ts        100 tool definitions; ~10 with realistic handlers, the rest as stubs
  skills.ts       5 skills, including investigate_anomalous_transactions
  index.ts        Two-mode runner — registers tools + skills, runs both modes, writes recordings
recordings/
  raw.json        Real trace from the last raw-mode run
  agentified.json Real trace from the last agentified-mode run
```

## Run it

Requires:
- `agentified-core` binary (built with `cargo build --release` from `src/core`)
- `OPENAI_API_KEY` in your env or in `<repo-root>/.env`

```bash
# Terminal 1: start the core (BM25 mode works; semantic + rerank also work if OPENAI_API_KEY is set)
agentified serve --dataset financebot

# Terminal 2: register tools, run both modes, write recordings
cd examples/financebot-showcase
pnpm install
pnpm start
```

After it finishes, open the inspector to see the side-by-side:

```bash
agentified inspect --recordings ./recordings
# → http://localhost:9120 — click "Compare ⇄" for a side-by-side view
```

## Tuning

Env vars on the showcase script:

- `AGENTIFIED_URL` (default `http://localhost:9119`)
- `AGENTIFIED_DATASET` (default `financebot`)
- `FINANCEBOT_MODEL` (default `gpt-4o-mini`)
- `FINANCEBOT_MAX_STEPS` (default `14`)
- `FINANCEBOT_PRICE_INPUT` / `FINANCEBOT_PRICE_OUTPUT` (per-1M-token, override if you swap models)

## Why this exists

This is the artifact for the "Ramp for agentic spending" pitch: same engine, two surface metrics. The dev-productivity story (skills, suggestions, reliability) and the cost story (token count, dollar cost per task) render in the same inspector — and now both are measured from real runs.
