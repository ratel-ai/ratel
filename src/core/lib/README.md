# `ratel-core`

The Rust library at the heart of Ratel. Retrieval, auth, and telemetry are implemented here; every other piece of the project (SDKs, benchmark, future server and integrations) is a wrapper around this crate.

## Library shape

- Crate name: `ratel-core`
- Library name: `ratel_core`
- In-process; no infra dependencies
- Member of the root Cargo workspace

## Build & test

From the repo root:

```bash
cargo build -p ratel-core
cargo test  -p ratel-core
cargo clippy -p ratel-core --all-targets -- -D warnings
```

Or run against the whole workspace using the commands in the root `CLAUDE.md`.
