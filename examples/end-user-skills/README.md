# `examples/end-user-skills` — Ratel + Cloud, one end-user's skill gap

Demonstrates the full loop Ratel Cloud's end-user dimension exists for: an opaque
end-user's usage flows in through the SDK, Cloud notices a recurring, uncovered ask
and drafts a skill scoped to that one user, and this script reviews it (approve or
reject) — all through `@ratel-ai/cloud`'s `CloudClient`, no mocks, no direct DB access.

1. **Sync** — pull the project's published skills into a live `SkillCatalog`.
2. **Simulate the end-user** — one ask a published skill already covers (searched
   *and* invoked, a real trace pair), one it doesn't (a coverage gap).
3. **Export + categorize** — flush the trace-event exporter, then force Cloud's
   categorization pass on demand (`cloud.categorizeQueries()`) rather than
   waiting for the ~hourly cron cadence.
4. **Generate** — ask Cloud for suggestions; with the demo's lowered occurrence
   threshold, a single ask already counts as "recurring" for this end-user.
5. **Review** — list the pending proposal(s) scoped to this end-user's id, and
   approve or reject one through `cloud.suggestions`.

## Setup

You need a running Ratel Cloud dev server (from the `ratel-websites` repo) with a
database and `ANTHROPIC_API_KEY` configured (real skill drafting needs a real model
call):

```bash
# in ratel-websites/
pnpm dev:cloud   # http://localhost:3000
```

`apps/cloud/.env.local` sets `SUGGESTIONS_MIN_INTENT_OCCURRENCES=1` and
`SUGGESTIONS_MIN_PER_USER_INTENT_OCCURRENCES=1` for local demo purposes — Cloud's
real default is `3` (see `lib/suggestions/signals.ts`); override either env var to
try a different threshold.

Seed a small demo project (a project + API key + two published skills — nothing
about end-users, telemetry, or suggestions; the rest of this script produces all of
that for real):

```bash
# in ratel-websites/
pnpm --filter @ratel/cloud seed:end-user-demo
```

This prints a fresh `rtl_...` API key. Then, from this directory:

```bash
pnpm install
RATEL_CLOUD_API_KEY=rtl_... pnpm start
```

## CLI flags

```bash
pnpm start -- --user=demo-user-2 --action=approve
pnpm start -- --user=demo-user-3 --action=reject --gap-query="draft a customer refund policy"
```

- `--user=<id>` — the opaque end-user id (default `demo-user-1`). Use a different
  id per run to see fresh suggestions — Cloud dedupes a pending/approved proposal
  for the same (project, intent, end-user), so re-running with the same user *and*
  the same `--gap-query` after an approve won't produce a new one (rejects don't
  block regeneration, so that path *can* be re-run).
- `--action=approve|reject` — skip the interactive prompt.
- `--occurrences=<n>` — how many times to repeat the uncovered ask (default `1`,
  matching the lowered threshold above; raise to `3` if you reset Cloud's env vars
  to the real defaults).
- `--gap-query=` / `--covered-query=` — override the simulated asks.

## Env

- `RATEL_CLOUD_URL` — Cloud origin (default `http://localhost:3000`).
- `RATEL_CLOUD_API_KEY` — the project API key from `seed:end-user-demo` (required).

## What this surfaced (and fixed) in Cloud

Building this demo found that `@ratel-ai/cloud`'s `SuggestionsClient` — `list` /
`get` / `approve` / `reject` / `generate` over `/api/v1/suggestions*` — had no
server-side route to call: Cloud only ever implemented the dashboard-session-authed
`/api/suggestions*` (no `v1`). The Bearer-key-authed `/api/v1/suggestions*` family
now exists in `apps/cloud/app/api/v1/suggestions/`, reusing the exact same
project-scoped DB functions the MCP server and embedded chat agent already share.

Similarly, there was no Bearer-authed way to force query categorization —
`/api/query-intents/categorize` (the on-demand, throttle-bypassing trigger) was
dashboard-session-only, and the only Bearer-reachable path, `/api/cron/drain`, is
throttled to ~once/hour per project (so a second demo run within the hour silently
saw none of its new trace events categorized — the bug that motivated this fix).
`CloudClient.categorizeQueries()` now calls a new
`POST /api/v1/query-intents/categorize` that bypasses the throttle, exactly like
its session-authed sibling.

Two other real gaps this demo needed closed, also fixed rather than routed around:

- The SDK had no end-user concept anywhere. `CloudExporterOptions.endUserId`
  (`src/sdk/cloud/src/exporter.ts`) now stamps every buffered envelope that doesn't
  already carry its own `end_user_id`.
- The SDK's `Suggestion` type was missing `endUserId`, even though Cloud's own
  `SerializedSuggestion` always had it — added for parity so a host can actually
  filter `cloud.suggestions.list()` results by end-user, as this script does.

## Known boundary (not fixed, by design)

An approved per-user `new_skill` suggestion lands as a **draft**, scoped to that
end-user, in Cloud's database — but `GET /api/v1/catalog` (what `SkillSync` pulls)
serves only published, *global* skills. A user-scoped skill never syncs into an SDK
host's `SkillCatalog` today; the dashboard shows a "not yet synced" badge for
exactly this reason. This script prints a note about it rather than pretending
otherwise — closing that gap needs the SDK to identify its end-user at catalog-pull
time, which is future work, not something this demo should paper over.
