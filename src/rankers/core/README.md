# `src/rankers/core/` — `ratel-ai-rankers`

The decision-model rankers behind [`@ratel-ai/rankers-plugin`](../ts/README.md) and [`ratel-ai-rankers-plugin`](../python/README.md) ([ADR 0028](../../../docs/adr/0028-vendor-rankers-as-plugin-packages.md)). The crate is internal (`publish = false`): the plugin packages build it from the workspace. It does not depend on `ratel-ai-core`.

A vendor is a `ChoiceBackend`, which supplies its endpoint, key variable and request shape. `ChoiceRanker<B>` drives any backend and owns everything else:

- reading the key at call time
- the per-question limits (150 options, 80,000 characters)
- the parallel tournament for larger candidate sets
- dropping near-zero picks
- the `RankerError` type

`ranker_for(vendor, config)` picks a backend by id at runtime. The two bindings call it so neither repeats per-vendor code.

| Feature (default on) | Backend | Ranker |
|---|---|---|
| `jev` | `JevConfig` (Jev, TypeSafe AI) | `JevRanker` |
| `openai-decision` | `OpenAIDecisionConfig` (OpenAI Decisions, beta) | `OpenAIDecisionRanker` |

Adding a vendor means writing one backend module behind a new feature and adding one arm to `ranker_for`.

## Layout

```
src/lib.rs               crate docs + re-exports
src/choice.rs            ChoiceBackend, ChoiceRanker, Http, RankerError, limits, tournament
src/vendor.rs            ranker_for / vendors / AnyRanker: runtime selection for the bindings
src/jev.rs               Jev wire format (feature `jev`)
src/openai_decision.rs   OpenAI Decisions wire format (feature `openai-decision`)
src/test_support.rs      mock HTTP request reader (tests only)
```

## Build & test

```bash
cargo test -p ratel-ai-rankers
cargo test -p ratel-ai-rankers --no-default-features --features jev   # one vendor
```
