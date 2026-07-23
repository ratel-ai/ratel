# src/graph/

`ratel-ai-graph` — rebuild a **usage-ranking intent graph** by replaying local trace logs,
and look at what it contains.

The learner in [`ratel-ai-core`](../core/README.md) grows a graph from live events, but it
holds it in memory: a fresh process starts knowing nothing. `JsonlSink` has been writing
every search and invoke to `~/.ratel/telemetry/<project>/*.jsonl` all along, so that log is
already a durable record of everything the learner would have seen. Replaying it
reconstructs the graph without introducing any storage of its own.

Replay runs through the **same** `UsageLearner` the live path uses, stamped with each
envelope's own timestamp, so a replayed graph is what the live path would have grown rather
than an approximation of it. Sessions are grouped and replayed separately: a confirmed
observation is a search and an invoke from *one* session, and pairing across sessions would
invent edges nobody produced.

The graph shape is [`protocol/v1`](../../protocol/v1/README.md); the decisions behind it are
[ADR-0014](../../docs/adr/0014-adaptive-usage-ranking.md).

## Layout

- `src/lib.rs` — `replay_dir` / `replay_envelopes` (log → graph) and `render` (graph → text).
- `src/main.rs` — the `ratel-graph` binary.
- `tests/replay.rs` — replay/live equivalence, session isolation, and the messiness of a real
  trace directory (nested project dirs, a truncated final line, non-JSONL files).

## Usage

```bash
# summarize the graph a replay produces (defaults to ~/.ratel/telemetry)
cargo run -p ratel-ai-graph -- show [dir]

# emit it as protocol/v1 JSON on stdout
cargo run -p ratel-ai-graph -- build [dir] > graph.json
```

`show` prints counts before the clusters, which is what distinguishes *no telemetry* from
*telemetry, but nobody ever invoked anything after a search* — both end in an empty graph and
they are very different problems.

```text
1 file(s), 11 event(s), 4 session(s)

is the build broken again  (3 observations)
  terms:   broken, build, again, main
  members: 3
  tools:   gh_run_list 2.80
```

An edge weight is below its observation count because weights decay: three uses spread over
four days are worth less than three today. Only the relative order within a cluster is
load-bearing.

Nothing is written to disk — `build` prints to stdout, so redirect it where you want it.
Durable storage for graphs is a separate concern.

## Not a release unit

`publish = false`. Release units are defined in `scripts/release-units.mjs`, and adding one
costs a tag prefix, a Trusted Publisher registration, and a manual first publish
([ADR-0008](../../docs/adr/0008-release-engineering.md)). This is a local tool; promote it
deliberately if it earns a release.
