# FinanceBot showcase

A concrete demo of Agentified's leverage story: 100 simulated finance tools curated down to a single skill activation for one canned task.

The shape mirrors the kind of agent a small finance org would build — ledger, CRM, docs/comms, and miscellaneous utilities — and shows two recordings of the same task ("investigate anomalous transactions → CFO memo") so you can compare:

1. **`raw.json`** — all 100 tools dumped at the model. ~24.5k tokens loaded, 14 tool calls, 4 reliability issues, $0.07/task.
2. **`agentified.json`** — Agentified curates down to a single skill (7 atoms). ~1.8k tokens, 7 calls, no reliability issues, $0.005/task.

## Layout

```
src/
  tools.ts        100 simulated tools (40 ledger, 30 CRM, 20 docs/comms, 10 misc)
  skills.ts       5 skills, including investigate_anomalous_transactions
  index.ts        Registers tools + skills with a running agentified-core
recordings/
  raw.json        Trace of the raw run (canned)
  agentified.json Trace of the curated run (canned)
```

## Run it

The scripts assume a local `agentified-core` is running on `http://localhost:9119`.

```bash
# Terminal 1: start the core (BM25 mode works without OPENAI_API_KEY)
agentified serve --dataset financebot

# Terminal 2: register tools + skills
cd examples/financebot-showcase
pnpm install
pnpm start
```

Then open the inspector:

```bash
agentified inspect --recordings ./recordings
# → http://localhost:9120
```

## What's canned vs real

- The 100 tools and 5 skills are **real** — they register against the live core via the SDK and are visible to any MCP client (Claude Code, Cursor, etc.) once `agentified mcp --dataset financebot` is wired up.
- The two **recordings** are static JSON for the showcase. The numbers are plausible illustrations of the leverage story, not benchmarks. Phase 6 will replace them with traces captured from real runs.

## Why this exists

This is the artifact for the "Ramp for agentic spending" pitch: same engine, two surface metrics. The dev-productivity story (skills, suggestions, reliability) and the cost story (token count, dollar cost per task) render in the same inspector.
