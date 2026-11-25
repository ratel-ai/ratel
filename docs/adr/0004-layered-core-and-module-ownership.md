# 4. A layered core, and modules that own their schema

## Status

Accepted

## Context

The platform is a large application: ingest, catalogs, the intelligence readings, the page
read models and the MCP operations. Without a stated direction for imports, it grows import
cycles and modules that reach into each other's tables. Most of its code came from the
`ratel-cloud` application, which is frozen and is being retired.

## Decision

**The core under `src/lib` is layered. Imports point downward only.**

| Level | Folders | Holds |
|---|---|---|
| L0 | `contracts`, `adapters`, `composition` | ports, their OSS implementations, the composition roots |
| L1 | `platform`, `jobs` | db client and migrator, logger, http, otel, env; the job runner, drain and scheduler |
| L2 | `ingest`, `catalog` | OTLP and runtime-event ingest; catalogs and skills |
| L3 | `ledger` | turns, steps, the closed-turn reader |
| L4 | `readings` | intent engine and graph, topics, signals, workflows, decisions |
| L5 | `synthesis` | match quality, quality, experiments, playground, traces, tool crafter |
| L6 | `views`, `console` | page read models; scope, navigation, settings, projects, onboarding |
| L7 | `mcp` | the MCP operations |

`pnpm check:layers` enforces it: a file in level L imports only levels at or below L, and
nothing under `lib/` imports `@/components` or `@/app`. Test files are exempt.
`lib/composition/registry.ts` is the one root that imports every module. `app/**`,
`components/**`, `proxy.ts` and `instrumentation*.ts` sit above L7. `scripts/layers-allow.json`
is a ratchet: it is empty, and an entry is a visible exception.

**Each module owns its schema, queries and registration.** A module ships `schema.ts`,
`queries.ts` and `register.ts` (its job handlers and drain steps). `platform/db` holds no
table. `jobs/` learns of modules only through the `registry` port. Migrations are generated
from the composed schema; an existing migration file is never edited, and `db:check` in CI
fails when the schema has a change that no migration covers.

**The code is maintained here.** It came from `ratel-cloud`, which is frozen; the sync that
landed it is retired. Comments that say "upstream" or "Owned" record where code came from and
bind no one.

**The open-source edition runs with no vendor account.** Model use is server-side and opt-in
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). With no key there is no outbound call, and each
feature falls back to its non-model behaviour. No event or log carries member text, queries,
prompts or labels.

## Consequences

- The layer check keeps the structure. A new folder under `src/lib` needs a level.
- A module can be read, tested and removed as a unit.
- Any file can be edited here; no tool overwrites it.
