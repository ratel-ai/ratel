<div align="center">
  <h1>ratel-ai-core</h1>
  <h4>Rust core for Ratel — BM25 retrieval over an agent's tool catalog, in-process, no infra.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://crates.io/crates/ratel-ai-core"><img src="https://img.shields.io/crates/v/ratel-ai-core?label=crates.io&color=e57300" alt="crates.io" /></a>
    <a href="https://docs.rs/ratel-ai-core"><img src="https://img.shields.io/docsrs/ratel-ai-core?label=docs.rs" alt="docs.rs" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-ELv2-blue" alt="license" /></a>
  </p>
</div>

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

Tools are the first content type indexed by the core. Tool search is BM25 over a deterministic flat-text projection of each `Tool`: its `name`, `description`, and a walk of both `input_schema` and `output_schema`. Only semantic tokens (property names, descriptions, enum values) are emitted; JSON Schema structure (`type`, `required`, `$ref`, braces, quotes) is skipped. See [ADR‑0004](../../../docs/adr/0004-bm25-tool-indexing.md) for the algorithm and rationale. The same retrieval primitive carries forward to skills, memories, and message history as those land on the [roadmap](../../../docs/roadmap.md).
