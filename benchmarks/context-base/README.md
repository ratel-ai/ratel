# Context-Base Benchmark

Measures how well AI agents select the right tools from a large registry, comparing three context strategies across ~40 scenarios (retrieval, actions, multi-turn, negative, ambiguous, cross-domain, distractor resistance, scale stress).

## Agents

### Oracle

Knows exactly which tools each scenario needs. Receives **only** the expected tools — no discovery, no noise. This is the theoretical upper bound on performance.

### Baseline

Receives **all** registered tools in every request. The model must pick the right ones from the full set. Measures raw model capability without any context filtering.

### Agentified

Tools are registered with the Agentified server. At query time, the server resolves which tools are relevant and serves only those to the agent. Measures Agentified's context intelligence layer.

## Setup

### Prerequisites

- Node.js, pnpm
- `OPENAI_API_KEY` env var (for embeddings)
- Model-specific API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`)
- Docker (agentified agent auto-starts an `agentified-core` container, or set `AGENTIFIED_ENDPOINT`)

### Running

```bash
# Run all three agents on a model
MODEL=gemini-3-flash-preview pnpm benchmark:all

# Run the benchmark test directly
MODEL=gemini-3-flash-preview pnpm benchmark

# Compare results from a run
pnpm compare results/<run-folder>
```

### Results

Each run produces a timestamped folder in `results/` containing:
- `.json` — structured benchmark results per agent
- `.jsonl` — per-scenario line-delimited results
- `.log` — execution logs
- `recap.md` — comparison table

## Metrics

| Metric | Description |
| --- | --- |
| Tool F1 | Harmonic mean of precision and recall on tool selection |
| Tool Precision | Did the agent avoid calling unnecessary tools? |
| Tool Recall | Did the agent call all required tools? |
| Task Correctness | Did the agent produce the right answer? |
| Negative Correctness | Did the agent correctly reject out-of-scope queries? |
| Hydration Recall | Were all expected tools hydrated/selected by the context layer? |

## Key Insight

Agentified aims to match oracle-level tool selection accuracy while dramatically reducing input tokens vs baseline — fewer tokens means lower cost and faster responses without sacrificing quality.
