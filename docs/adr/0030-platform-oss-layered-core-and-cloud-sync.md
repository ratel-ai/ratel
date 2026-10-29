# 30. Ratel Platform: five ports, a layered core, and a repeatable sync from ratel-cloud

Date: 2026-10-28

## Status

Accepted

Amends [ADR-0029](0029-platform-cloud-modules-private-repository.md) (two spike ports become
five; the core is layered) and [ADR-0002](0002-product-split-engine-local-cloud.md) (the
self-hosted platform is now a product rung). Consistent with [ADR-0009](0009-licensing.md): no
proprietary code enters this repository.

## Context

The Cloud application (`ratel-cloud/apps/web`: about 2,170 TypeScript files, 67 tables, 10
background job kinds) is to become the open-source Ratel Platform at `apps/web`, with the Cloud
edition composed from the private checkout at `ee/src` as ADR-0029 decided. Three things make a
plain copy unworkable:

- The Cloud code reaches into five hubs from everywhere: the Clerk-backed session context (88
  importers), PostHog event tracking and exception reporting (60 and 68), Stripe-backed
  entitlements (39) and the admin console (78). One schema file holds every table, and one
  3,300-line queries file imports eleven modules upward.
- The intelligence code (Agent health, topics, the intent engine and graph, match quality) is
  80,000 lines with two import cycles and no stated dependency direction.
- `ratel-cloud` keeps shipping while the move happens, so the copy has to be repeatable, not a
  snapshot, and the code that stays private (billing, identity, the Tool Picker and Embedding
  APIs, PostHog, the admin console, infrastructure) must be impossible to land by accident.

## Decision

**Five ports, in `apps/web/lib/contracts`.** `session` (principal, organization, role, projects,
`accessGranted`, `actingAs`), `entitlements` (limits, quotas, metered features, `planId`),
`telemetry` (events, identify, exceptions), `embedding-provider`, and `registry` (job handlers and
drain steps a module contributes). They replace the spike's `identity` and `workspace`. Email is
not a port (no open-source caller); admin is not a port (support sessions become `actingAs` on
the session principal). The OSS adapters are a single local operator with one organization,
unlimited entitlements, log-line telemetry, an OpenAI or local-hash embedder, and an empty
registry. The composition root is split: `lib/composition/ports.ts` assembles the ports and
imports no module; `lib/composition/registry.ts` imports every module's `register.ts`.

**A layered core under `apps/web/lib`**, imports pointing downward only:

| Level | Folders | Holds |
|---|---|---|
| L0 | `contracts`, `adapters`, `composition` | ports, their OSS implementations, the roots |
| L1 | `platform`, `jobs` | db client and migrator, logger, request log, rate limit, http, otel, env; the job runner, store, drain and scheduler |
| L2 | `ingest`, `catalog` | OTLP and runtime-event ingest, catalogs; the catalog contract and skills |
| L3 | `ledger` | turns, steps, closed-turn reader, verdict store |
| L4 | `readings` | intent engine, intent graph, topics, signals, workflows, self-corrections, match quality, tool explorer, decisions |
| L5 | `synthesis` | tasks, fixes, health summary, quality, experiments, playground, traces, tool crafter, health imports |
| L6 | `views`, `console` | page and view models; scope, navigation, settings, projects, onboarding, seeds |
| L7 | `mcp` | the MCP operations |

`scripts/check-layers.mjs` enforces it with the import walker of `check-ee-boundary.mjs`: a file
in level L imports only levels at or below L; nothing under `lib/` imports `@/components` or
`@/app` outside tests; `lib/composition/registry.ts` is the one root exempt from the rule.
`scripts/layers-allow.json` is a ratchet: an entry silences one violation while copied code is
being layered, a stale entry fails the check, so the list can only shrink. `app/**`,
`components/**`, `proxy.ts` and `instrumentation*.ts` sit above L7 and may import any layer.

**Each module owns its schema, queries and registration.** `platform/db` exports the client, the
migrator, the statement-timeout helper and a schema composer; it holds no table. A module ships
`schema.ts`, `queries.ts` and `register.ts` (its job handlers and drain steps), and `jobs/` learns
of them only through the registry. The open-source edition starts from a fresh migration set
generated from the composed schema, regenerated as `0000_init` until the first OSS release tag;
`db:check` in CI fails on drift. The Cloud database is not migrated by this work.

**A repeatable sync from `ratel-cloud` main**, in `scripts/platform-sync/`. `map.json` lists what
moves where in three modes: `copy` (mirrored on every sync, import specifiers rewritten to the
layer paths and to `@ratel/design-system`), `owned` (bootstrapped once, then maintained here; the
sync prints the upstream diff for a human to port), `excluded` (never lands). `private-strings.txt`
names the Cloud-only vendors and the private decision engines as patterns scoped to
`apps/web`, and carries the customer whose data appears in Cloud fixtures only as a salted hash
checked against the whole tree, so the name is never written in this repository; a landed file matching any pattern fails the sync before a byte is written,
and CI greps `apps/web` and the OSS image with the same list. `source.json` records the commit
synced. Owned files keep the upstream export names (`getSessionContext`, `trackServerEvent`,
`reportServerException`, `getLimits`), so call sites stay byte-identical to upstream and the
owned set stays small.

**What stays private**, handled in `ratel-platform` (out of this repository's scope): billing
(Stripe, wallets, pricing), identity (Clerk, memberships, invitations, platform invites, MCP
OAuth), the Tool Picker and Embedding APIs and their guide pages, the access waitlist and the
one remaining feature flag, PostHog, the admin console and support sessions, the "held for us"
review path of Agent health imports, the Jev and Sage decision clients, the customer replay seed,
and all infrastructure (Terraform, Helm, deploy workflows).

**Model use in the open-source edition** is server-side, environment-keyed and opt-in:
`ANTHROPIC_API_KEY` for engine level-1 names, topic names, the match-quality analyst and task
labels; `OPENAI_API_KEY` for topics placement and sentiment, the match-quality judge, Agent health
workflow decisions and Playground embeddings. The intent engine clusters lexically at every
level; a model only writes names. The decisions client ships with OpenAI only: `DECISION_ENGINE`
names no other engine here, and the Jev and Sage clients stay private. With no key there is no
outbound call and every feature degrades as upstream does. Retention is on by default in OSS (`DATA_RETENTION_ENABLED=1`, 30
days), and no event or log carries member text, queries, prompts or labels.

**`@ratel-ai/sdk` from npm**, pinned to the version `ratel-cloud` runs, hoisted only inside the
Docker deps stage. The in-tree SDK needs the Rust toolchain to build its native addon, which the
image does not carry; a `workspace:*` dependency is a follow-up once the image builds the addon.

## Consequences

- The open-source edition builds, tests and runs with no Clerk, Stripe, PostHog, Resend or model
  key, and an outside contributor's checkout never contains a private module or a customer name.
- Until `ratel-cloud` is retired, a change there reaches this repository through
  `pnpm platform:sync`; the reviewer reads only the owned-drift section. The owned set is the
  standing cost: every owned file is a place where the two trees can diverge.
- The layer check holds the structure after the move; the allowlist shows how far the layering
  has progressed and cannot grow.
- A fresh migration set means the open-source schema and the Cloud schema share tables by name
  but not migration history. The Cloud side reconciles when `ratel-platform` adopts the composed
  schema; this repository never runs against the Cloud database.
- The spike's `ee/src` no longer typechecks against the five ports; `ratel-platform` adapts to the
  new `CompositionPorts` when the Cloud adapters are written.
