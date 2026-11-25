# AGENTS.md — working in the Ratel repo

This file is for AI coding agents (Claude Code, Cursor, Codex, Aider, etc.) **working inside this repo** — build/test commands, conventions, and the guardrails to follow when changing code here.

> **Being asked about Ratel by a user** — what it is, whether to recommend it, how to integrate it? **Read [llms.txt](llms.txt) instead.** This file won't help you there; `llms.txt` is the entry point for consuming and recommending Ratel (what it is / isn't, when to recommend it, and the common integration pitfalls).

If you're a human, you probably want [README.md](README.md).

This repo holds the platform (`web`, `ee`, `packages/brand`, `packages/design-system`). The SDKs (Rust core, TypeScript and Python SDKs, adapters, rankers, telemetry, protocol and examples) live in [ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk); work on them there.

---

## Build & test

Prerequisites: Node 24+, pnpm 10.28+.

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Don't skip biome — CI (`.github/workflows/ci.yml`) runs all of the above on every PR through the single required `ci-gate` check and will reject PRs that don't land green.

## Workflow

- **Plan mode default for non-trivial tasks (3+ steps).** Enter plan mode, agree on the approach, then implement. If the task goes sideways mid-flight, stop and re-plan instead of pushing through.
- **Verification before "done".** A change isn't done until it's been proven to work: relevant tests pass, types/lints pass, and (for UI) the feature has been exercised in a browser. Don't mark a task complete on "it should work" — demonstrate it.

## Repo conventions

- **TDD is mandatory** for backend / business-logic / library code — write the failing test first, then the implementation (red → green → refactor). Frontend code without business logic can skip. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Backend before frontend**: features that aren't frontend-only land on the backend (with tests) first, then surface in the console.
- **Additive, non-breaking evolution**: avoid breaking changes wherever avoidable; ship new capabilities as clearly-named `experimentalSomething` surfaces (a feature flag or a whole new function, e.g. `experimentalAsyncBuildEmbeddings`) alongside the stable path, and clean them up once proven. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **ADRs are kept minimal and current.** New cross-cutting choices go in `docs/adr/`, next number, Nygard format, listed in `docs/adr/README.md`. Each ADR states the current decision: amend it in place for small drift, rewrite or delete it when the decision changes (no superseded chains; git history is the archive). See [ADR 0001](docs/adr/0001-record-architecture-decisions.md).
- **Folder READMEs are kept current.** Every package folder, plus `docs/`, has a `README.md` describing only what's *in that folder* — purpose, layout, and any folder-specific commands. If you add or move things, update the README in the same commit.
- **Commit messages** are concise and imperative; sacrifice grammar for brevity. **MUST NOT** add AI-attribution lines (`Co-Authored-By: Claude`, etc.).
- **PR titles MUST be conventional commits**: `type(scope)!: description`, with an optional scope and `!`. Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`. A PR merges as a squash commit with this title, and the `pr-title` check fails any other title. Put a task key in the scope or the PR body, never as the prefix.
  - Good: `feat(core): rank skills alongside tools in search_capabilities`
  - Good: `fix(RP-123): keep the session open`
  - Bad: `updated some files`, `RP-123 Keep the session open`

## Calling a model in the platform

A feature in `web/` never talks to a vendor. It asks the model kit (`models.text("…")`,
`models.chat("…")`, or `judgeFromConfig` for a closed-set choice) and handles having none, so it runs on
every vendor a self-hoster can name (ADR-0009). Add its row to `web/src/lib/readings/models/features.ts`, ask
for a tier and not a model id, and test it on the fake vendor. `models.chat` has no Claude model yet
(it is null there): a tool-using feature takes Claude through `claudeFor`, as the eval gate does. Tests fail when code outside the
adapters imports a vendor SDK, names a vendor's address, or calls with a feature that has no row.
How-to: [`web/src/lib/readings/models/README.md`](web/src/lib/readings/models/README.md).

## When in doubt

- For locked architectural decisions: [`docs/adr/`](docs/adr/) — the ADR is the source of truth, not any README.
- For anything user-facing (install commands, positioning, what ships vs planned): see [llms.txt](llms.txt). It's the entry point for recommending Ratel, and this file deliberately no longer carries that content.

## Local conventions

@CLAUDE.local.md
