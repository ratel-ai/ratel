# Contributing to Ratel

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) v2.1. By participating, you're agreeing to abide by it. Report incidents to `conduct@ratel.sh`.

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
- Conventional-commits-ish prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`) where useful — these route into per-package CHANGELOGs (see Releases)
- Use a scope when the change is package-specific: `feat(sdk):`, `fix(cli):`, `refactor(core):`. Unscoped `feat`/`fix` won't auto-route to a single package's changelog
- No tool-attribution lines (no `Co-Authored-By` for AI assistants)

## Releases

We publish `ratel-ai-core` (crates.io) and `@ratel-ai/sdk` (npm) from this repo. Each has a `CHANGELOG.md` in its package directory. The MCP-server library `@ratel-ai/mcp-server` is published independently from [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp).

Before tagging a release:

1. Bump the version in `Cargo.toml` and `src/sdk/ts/package.json` (the release workflow validates each unit's tag against its manifests).
2. Run the `/changelog` skill (`.claude/skills/changelog/`). It drafts per-package entries with [git-cliff](https://git-cliff.org), lets you curate, and writes the CHANGELOGs. For GA versions (no `-rc` suffix), it collapses any existing `## [X.Y.Z-rc.*]` sections into a single `## [X.Y.Z]` section.
3. Commit the version bumps and CHANGELOG updates together (typically `release: vX.Y.Z`), tag, push.

The release workflow's `tag-version-check` job rejects any tag whose CHANGELOGs don't contain a `## [<version>]` heading. See [ADR 0008](docs/adr/0008-per-package-changelogs.md) for the full rationale.

## Pull requests

- Keep PRs focused — one logical change per PR
- Update `README.md` / `CONTRIBUTING.md` in the same PR if the change affects them
- Tag `@claude` to invoke automated review on GitHub if useful

## License

The kernel (`ratel-ai-core`) is licensed under [Apache-2.0](LICENSE-APACHE); every other component (SDKs, CLI, telemetry helpers, examples) is [MIT](LICENSE.md) — see [ADR-0017](docs/adr/0017-relicense-core-apache-2.md). By submitting a PR you agree your contribution is licensed under the terms governing the component it touches.
