# `lib/readings/tool-explorer` (L4)

The parts of the tool explorer that other readings and the pages already use. The explorer's own
job (which tool the agent calls next, and how often each path is taken) lands later, and fills
`mapSeams.loadToolSteps` in `lib/views/intents/map` when it does.

| File | Holds |
|---|---|
| `types.ts`, `units.ts` | the explorer's row shapes and the units its numbers are shown in |
| `reliability.ts`, `timing.ts`, `transitions.ts` | the pure arithmetic: failure rates, latency buckets, tool-to-tool transitions |
| `ledger.ts` | `listSessionTurns`: one session's turns in order, with their steps and asks, read from the ledger and the query-intents tables for a task's session page |

Every file mirrors upstream (`scripts/platform-sync/map.json`).
