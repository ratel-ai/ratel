# CLAUDE.md

## What Ratel is

Context engineering platform for AI agents — a library that decides what ends up in an agent's context window so the model works with less noise and fewer tokens.

Core is a Rust lib (`ratel-core`); language SDKs bundle it. In-process, no infra required.

## Layout

```
src/core/    Rust core
src/sdk/     language SDKs
benchmark/   eval harness
docs/        ADRs and other docs
```

Each folder has its own `README.md` with the details. Cargo + pnpm workspaces are rooted at the repo top level.

## Build & test

```bash
# Rust
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check --all
cargo test --workspace

# TS
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

CI (`.github/workflows/{rust,ts}.yml`) runs all of the above on every PR; PRs land green.

## Conventions

- **TDD** for backend / business logic / lib code (use the `tdd` skill). Frontend without business logic can skip.
- **Backend before frontend**: features that aren't frontend-only land on the Rust core (with tests) first, then surface in the SDK.
- **ADRs** for cross-cutting choices: new file in `docs/adr/`, next number, Nygard format. Don't edit accepted ADRs — supersede.
- **Commits**: concise, imperative. No AI-attribution lines.

## Where to find more

- `README.md` — public-facing overview
- `CONTRIBUTING.md` — contributor workflow, prerequisites, branching
- `docs/adr/` — every locked architectural decision and its rationale
- `LICENSE.md` — license terms
