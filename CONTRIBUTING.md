# Contributing to Ratel

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) v2.1. By participating, you're agreeing to abide by it. Report incidents to `conduct@ratel.sh`.

## Prerequisites

- **Node** 24+
- **pnpm** 10.28+ (see `packageManager` in `package.json`)

## Build & test

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

CI (`.github/workflows/ci.yml`) runs all of the above on every PR through the single required `ci-gate` check. PRs are expected to land green.

## Branching

- `main` — stable, and the current development target
- Branch off `main` for new work; PR back into `main`

## Backend before frontend

For features that aren't frontend-only, implement on the backend first (with tests), then surface in the console.

## SDKs

The SDKs (Rust core, TypeScript and Python SDKs, adapters, rankers, telemetry, protocol and examples) live in [ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk). Contribute to them there.

## TDD

Backend / business-logic / library code: TDD is the default — write the failing test first, make it pass, refactor. Frontend changes don't require TDD unless they encode business logic.

## Additive, non-breaking evolution

Avoid breaking changes wherever avoidable. Ship new capabilities as additive, clearly-named experimental surfaces — an `experimentalSomething` function/method or a feature flag (e.g. `experimentalAsyncBuildEmbeddings`) — alongside the stable path, so existing callers keep working while the new behavior is proven out. Once it's proven, promote it to stable (drop the `experimental` prefix) or remove it; don't leave `experimental*` surfaces to rot.

## Architecture decisions

For cross-cutting choices, write an ADR in `docs/adr/` — Nygard format (`Status` / `Context` / `Decision` / `Consequences`), next available number, kebab-cased title. The set is kept minimal and current: each ADR states the current decision, amended in place for small drift and rewritten or deleted when the decision changes (git history is the archive). List it in `docs/adr/README.md`. See [ADR 0001](docs/adr/0001-record-architecture-decisions.md) for the full convention.

## Commit messages

- Concise, imperative mood; sacrifice grammar for brevity
- Conventional-commits-ish prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`) where useful
- No tool-attribution lines (no `Co-Authored-By` for AI assistants)

## Releases

The SDK packages release from [ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk); see [RELEASING.md](RELEASING.md). The platform (`src`) is not released as a package: it ships from `main`.

## Pull requests

- Keep PRs focused — one logical change per PR
- Update `README.md` / `CONTRIBUTING.md` in the same PR if the change affects them
- Tag `@claude` to invoke automated review on GitHub if useful

## License

This repository is [MIT](LICENSE.md) — see [ADR-0006](docs/adr/0006-licensing.md). The engine (`ratel-ai-core`, Apache-2.0) lives in [ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk). By submitting a PR you agree your contribution is licensed under the terms governing the component it touches.
