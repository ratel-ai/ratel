# Contributing to Ratel

## Prerequisites

- **Rust** stable — pinned via `rust-toolchain.toml`; rustup picks it up automatically.
- **Node** 24+
- **pnpm** 10.28+ (see `packageManager` in `package.json`)

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

CI (`.github/workflows/{rust,ts}.yml`) runs all of the above on every PR. PRs are expected to land green.

## Branching

- `main` — stable
- `revamp` — v1 line, current development target until cutover
- Branch off `revamp` for new work; PR back into `revamp`

## Backend before frontend

For features that aren't frontend-only, implement on the Rust core first (with tests), then surface in the TS SDK.

## TDD

Backend / business-logic / library code: TDD is the default — write the failing test first, make it pass, refactor. Frontend changes don't require TDD unless they encode business logic.

## Architecture decisions

For cross-cutting choices, write an ADR in `docs/adr/` — Nygard format (`Status` / `Context` / `Decision` / `Consequences`), next available number, kebab-cased title. ADRs are immutable once `Accepted`; supersede, don't edit. See [ADR 0001](docs/adr/0001-record-architecture-decisions.md) for the full convention.

## Commit messages

- Concise, imperative mood; sacrifice grammar for brevity
- Conventional-commits-ish prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`) where useful
- No tool-attribution lines (no `Co-Authored-By` for AI assistants)

## Pull requests

- Keep PRs focused — one logical change per PR
- Update `README.md` / `CONTRIBUTING.md` in the same PR if the change affects them
- Tag `@claude` to invoke automated review on GitHub if useful

## License

Contributions are licensed under the project's [Elastic License 2.0](LICENSE.md). By submitting a PR you agree your contribution is licensed accordingly.
