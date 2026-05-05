# `src/core/`

The product's heart. All retrieval, auth, and telemetry logic lives here.

## Layout

```
lib/    ratel-ai-core — Rust crate, the public library API
```

A `server/` sibling will land here once a central server is needed (cross-instance telemetry, token vault, fleet observability). Until then, lib-only is the shipping path.

## `lib/` — `ratel-ai-core`

The Rust crate that every other piece of Ratel wraps. SDKs (`src/sdk/*`) bind to it; the benchmark links it directly; integrations call it through the SDK or directly.

Standalone Rust crate; no setup beyond the workspace `cargo` commands. See [`lib/README.md`](lib/README.md).
