# `ratel-ai-core`

The Rust library at the heart of Ratel. Retrieval, auth, and telemetry are implemented here; every other piece of the project (SDKs, benchmark, future server and integrations) is a wrapper around this crate.

## Library shape

- Crate name: `ratel-ai-core`
- Library name: `ratel_ai_core`
- In-process; no infra dependencies
- Member of the root Cargo workspace

## Build & test

From the repo root:

```bash
cargo build -p ratel-ai-core
cargo test  -p ratel-ai-core
cargo clippy -p ratel-ai-core --all-targets -- -D warnings
```

Or run against the whole workspace from the repo root with `cargo build --workspace` / `cargo test --workspace`.

## What gets indexed

Tool search is BM25 over a deterministic flat-text projection of each `Tool`: its `name`, `description`, and a walk of both `input_schema` and `output_schema`. Only semantic tokens (property names, descriptions, enum values) are emitted; JSON Schema structure (`type`, `required`, `$ref`, braces, quotes) is skipped. See [ADR‑0004](../../../docs/adr/0004-bm25-tool-indexing.md) for the algorithm and rationale.
