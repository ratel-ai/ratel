# CLAUDE.md

## What Ratel is

Context engineering platform for AI agents — a library that decides what ends up in an agent's context window so the model works with less noise and fewer tokens.

Core is a Rust lib (`ratel-ai-core`); language SDKs bundle it. In-process, no infra required.

## Layout

```
src/core/           Rust core
src/sdk/            language SDKs
src/integrations/   protocol surfaces (MCP server, ...)
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
```

CI (`.github/workflows/{rust,ts}.yml`) runs all of the above on every PR; PRs land green.

## Workflow

- **Plan mode default for non-trivial tasks (3+ steps).** Enter plan mode, agree on the approach, then implement. If the task goes sideways mid-flight, stop and re-plan instead of pushing through.
- **Verification before "done".** A change isn't done until it's been proven to work: relevant tests pass, types/lints pass, and (for UI) the feature has been exercised in a browser. Don't mark a task complete on "it should work" — demonstrate it.

## Conventions

- **IMPORTANT: TDD is mandatory** for backend / business-logic / library code — use the `tdd` skill (red → green → refactor). Frontend code without business logic can skip.
- **Backend before frontend**: features that aren't frontend-only land on the Rust core (with tests) first, then surface in the SDK.
- **IMPORTANT: ADRs are immutable once `Accepted` — never edit, always supersede.** New cross-cutting choices go in `docs/adr/`, next number, Nygard format.
- **Folder READMEs**: every folder under `src/`, plus `docs/`, has a `README.md` describing only what's *in that folder* — purpose, layout (children with one-liners), and any folder-specific build/usage commands. Keep them lean and timeless: no roadmap, no status, no version-specific framing. Link to deeper READMEs instead of duplicating their content. When you add a new folder of that kind, add its README in the same change.
- **Commits**: concise, imperative; sacrifice grammar for brevity. **MUST NOT** add AI-attribution lines (`Co-Authored-By: Claude`, etc.).
  - Good: `docs: drop CLAUDE.md refs from READMEs, codify folder-README rule`
  - Bad: `updated some documentation files`

## Lessons

When Claude makes a mistake, the rule that prevents the next occurrence goes in [`docs/lessons.md`](docs/lessons.md). Read it at the start of every session; append to it whenever a new rule is needed.

## Where to find more

- `README.md` — public-facing overview
- `CONTRIBUTING.md` — contributor workflow, prerequisites, branching
- `docs/adr/` — every locked architectural decision and its rationale
- `docs/lessons.md` — accumulated rules from past mistakes
- `LICENSE.md` — license terms

## Local conventions

@CLAUDE.local.md

