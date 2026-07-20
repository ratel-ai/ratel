# CLAUDE.md

## What Ratel is

Context engineering platform for AI agents — a library that decides what ends up in an agent's context window so the model works with less noise and fewer tokens.

Core is a Rust lib (`ratel-ai-core`); language SDKs bundle it. In-process, no infra required.

## Layout

```
src/core/           Rust core (ratel-ai-core engine)
src/graph/          usage-graph replay + inspection CLI (not a release unit)
src/sdk/            language SDKs
src/telemetry/      OTel telemetry conventions + helper packages
protocol/           catalog source wire contract (pull-sync + auth)
docs/               ADRs and other docs
```

The benchmark harness lives in its own public repo: [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench).

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

# Python (from src/sdk/python/; needs uv)
uv venv --python 3.11 .venv
uv pip install --python .venv maturin pytest pytest-asyncio ruff mypy
.venv/bin/maturin develop
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai && .venv/bin/pytest
```

CI (`.github/workflows/{rust,ts,python}.yml`) runs all of the above on every PR; PRs land green.

## Workflow

- **Plan mode default for non-trivial tasks (3+ steps).** Enter plan mode, agree on the approach, then implement. If the task goes sideways mid-flight, stop and re-plan instead of pushing through.
- **Verification before "done".** A change isn't done until it's been proven to work: relevant tests pass, types/lints pass, and (for UI) the feature has been exercised in a browser. Don't mark a task complete on "it should work" — demonstrate it.

## Conventions

- **IMPORTANT: TDD is mandatory** for backend / business-logic / library code — use the `tdd` skill (red → green → refactor). Frontend code without business logic can skip.
- **Backend before frontend**: features that aren't frontend-only land on the Rust core (with tests) first, then surface in the SDK.
- **ADRs: keep the set minimal and current.** New cross-cutting choices go in `docs/adr/`, next number, Nygard format. Amend in place for small drift (paths, names, counts, statuses); write a superseding ADR for real decision reversals; compact periodically when stale content accumulates (git history is the archive). Full convention in ADR-0001.
- **Folder READMEs**: every folder under `src/`, plus `docs/`, has a `README.md` describing only what's *in that folder* — purpose, layout (children with one-liners), and any folder-specific build/usage commands. Keep them lean and timeless: no roadmap, no status, no version-specific framing. Link to deeper READMEs instead of duplicating their content. When you add a new folder of that kind, add its README in the same change.
- **Commits**: concise, imperative; sacrifice grammar for brevity. **MUST NOT** add AI-attribution lines (`Co-Authored-By: Claude`, etc.).
  - Good: `docs: drop CLAUDE.md refs from READMEs, codify folder-README rule`
  - Bad: `updated some documentation files`

## Where to find more

- `README.md` — public-facing overview
- `CONTRIBUTING.md` — contributor workflow, prerequisites, branching
- `docs/adr/` — every locked architectural decision and its rationale
- `LICENSE.md` — license terms

## Local conventions

@CLAUDE.local.md

