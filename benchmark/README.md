# `benchmark/`

Rust harness for measuring Ratel's impact: retrieval quality, token savings, latency.

This is what backs every "Ratel does X better" claim. New product features that touch retrieval or context shape are expected to add a corresponding benchmark scenario before being declared done.

## Layout

```
src/main.rs   benchmark binary entry point
```

Crate name: `ratel-benchmark`. Member of the root Cargo workspace; not published.

## Running

```bash
cargo run -p ratel-benchmark
```
