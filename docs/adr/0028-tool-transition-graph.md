# 28. Tool transition graph: predict the next tool so the agent searches less

Date: 2026-10-12

## Status

Proposed. Accepted once `ratel-bench` has measured searches per turn and task success with and
without `experimentalNext` hints, as [ADR-0024](0024-hybrid-fuses-on-scores.md) was.

Builds on [ADR-0014](0014-adaptive-usage-ranking.md) (the intent graph; this lifts its rejected
"Tool↔tool co-usage" alternative), [ADR-0026](0026-turn-scope.md) (the turn is the sequence
boundary) and [ADR-0025](0025-intent-graph-storage-plugins.md) (persistence, unchanged).

## Context

Ratel searches once per tool step. A task that ends in `find_task → assign_task → notify` costs
at least three `search_capabilities` round-trips, each a model turn. The intent graph records,
per query cluster, *which* capabilities were invoked, but not in what order nor what tends to
follow what. It can lift `find_task` on the first search; it cannot tell the agent that
`assign_task` almost always comes next and `notify` sometimes does.

The engine already sees the evidence: successive `InvokeStart` events within one `turn_id`,
including host-run tools reported through `recordToolCall`.

## Decision

**Learn ordered tool→tool transitions per turn, globally and per intent cluster, and return
the likely chain on `search_capabilities` so the agent can invoke without searching again.**

### Model

- A transition table maps `prev → {next: count}`, with `n` = times `prev` was observed. `prev`
  may be the pseudo-state `<start>` (first tool of a turn).
- **`<end>` is derived, never stored**: `n − Σnext`. Core has no turn-end event, and needs none.
- Counts are raw integers, so tables from different processes add.
- One global table on the graph, and one per intent cluster. A per-intent table lives on its
  cluster and is evicted with it.
- Rows and next-maps are capped (internal constants); over a cap, the lowest counts go.

### Learning

- **A transition needs a `turn_id`.** Without one every session shares one key, and
  interleaved sessions would invent transitions nobody made. Unlike cluster credit, where a
  shared key under-counts, here it corrupts.
- On each tool invoke in a turn: `prev = last tool of the turn, else <start>`; count it
  globally, and under the turn's *anchor* intent when there is one. The anchor is the cluster
  the turn's first acted-on search was attributed to.
- Invokes before any search still count globally.
- Live learning and log replay share one step, so they cannot diverge.
- `learn: false` tracks the turn's last tool (needed to predict) but counts nothing.

### Serving

- `predict_next` returns the chain from the turn's last tool (or `<start>`), walking only
  **strong** edges (Wilson lower bound ≥ 0.6 on at least 5 observations), depth ≤ 3, no cycles,
  plus the top next tools after each requested id.
- The intent table is used when it has enough support; otherwise it backs off to global.
- `search_capabilities` carries this as `experimentalNext` when the caller opts in. A strong
  edge carries the tool's `inputSchema`, so it can be invoked without a search; a weak one
  carries its probability and count only.
- `invoke_tool` is untouched: it passes the target tool's raw result through, streams included,
  and wrapping it would break that.

### The feedback loop

A hint the agent follows looks like any other invoke. Counting it would let hints reinforce
themselves. The graph therefore records, per edge, how often it was offered and followed, and
**probabilities are computed from organic transitions only**. A hint can freeze an edge; it
cannot inflate it.

### Sources

The core trace stream is the source: it already carries `InvokeStart` for Ratel-routed and
`recordToolCall`-reported tools with `turn_id`. **No telemetry or trace attribute is added.**

For a host that uses no Ratel adapter but runs an OTel-instrumented framework, an opt-in,
read-only span processor observes `execute_tool` spans that start inside a Ratel turn and
reports them as external tool calls. It joins the turn from the in-process turn scope, never
from span attributes, and never mutates a span. It must not be combined with an adapter that
already records host tools, or each call is counted twice.

## Consequences

- The intent graph gains two optional wire fields; old graphs load unchanged and graphs with no
  transitions serialize byte-identically.
- The prediction is only as good as the turn boundary: hosts that never open a turn learn none.
- Per-intent tables are sparse on a single install; early value comes from the global table.
- Parallel tool calls are ordered by arrival; a batch of independent calls reads as a chain.

## Rejected

- **Hints on `invoke_tool` results**: breaks raw passthrough and streams.
- **New `ratel.turn.id` / `ratel.intent.id` span attributes**: the in-process join gives the
  same attribution with no telemetry change.
- **Mining full paths**: sparse; chains fall out of single-step transitions.
- **Storing probabilities**: not mergeable; counts are.
