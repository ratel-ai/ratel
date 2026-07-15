# `examples/end-user-skills-app` — Next.js + AI SDK agent on Ratel

The [`end-user-skills`](../end-user-skills) loop as a real host app: a Next.js
chat UI whose **AI SDK (v7) agent** carries a live Ratel `SkillCatalog` synced
from Ratel Cloud, with the **per-user skill suggestion flow** (generate →
review → approve/reject) built into the page. No mocks — every panel is a real
HTTP call through `@ratel-ai/sdk` + `@ratel-ai/cloud`.

- **Chat (left)** — each substantive ask makes the agent call `search_skills`
  (a traced BM25 `searchTraced` on the user's catalog) and, on a match,
  `use_skill` (a real, search-attributed `skill_invoke`). The tool chips under
  each answer show it happening. One `TraceSession` + `CloudExporter` per
  opaque end-user id, so all telemetry is attributed to that user.
- **Skill catalog (top right)** — the published global catalog straight from
  Cloud's `GET /api/v1/catalog`, i.e. exactly what `SkillSync` pulls into
  every user's live catalog.
- **Skill suggestions (bottom right)** — "Generate suggestions from my usage"
  flushes the user's trace events, forces Cloud's categorization pass
  (`CloudClient.categorizeQueries()`, bypassing the ~hourly cron throttle),
  runs suggestion generation (a real model call drafts the skill), and lists
  the pending proposals scoped to this end-user with Approve/Reject.

The header assigns a fresh random end-user per page load (Cloud dedupes
pending/approved proposals per (project, intent, end-user), so a fresh id per
demo run always yields a fresh proposal). Type your own id or hit "↻ new".

## Run it

Two servers. First, Ratel Cloud (from `ratel-websites`), seeded:

```bash
# in ratel-websites/apps/cloud — .env.local needs DATABASE_URL, ANTHROPIC_API_KEY,
# and (for a snappy demo) SUGGESTIONS_MIN_INTENT_OCCURRENCES=1 +
# SUGGESTIONS_MIN_PER_USER_INTENT_OCCURRENCES=1
PORT=3100 pnpm dev
pnpm seed:end-user-demo   # prints a fresh rtl_... API key each run
```

Then this app:

```bash
# in this directory — .env.local:
#   RATEL_CLOUD_URL=http://localhost:3100
#   RATEL_CLOUD_API_KEY=rtl_...        (from the seed output)
#   ANTHROPIC_API_KEY=sk-ant-...       (for the chat agent)
pnpm dev                               # http://localhost:3000
```

Demo script: click the "Write unit tests…" starter (covered — watch the
search + invoke chips), ask "Draft a customer refund policy document" (no
match), then "Generate suggestions from my usage" → approve the drafted
per-user skill.

## Notes

- `lib/ratel.ts` loads `@ratel-ai/sdk` via a bundler-invisible `createRequire`
  because this example consumes the **unpublished workspace SDK** and Next
  bundles monorepo-local packages even when they're in
  `serverExternalPackages` — which breaks the SDK's native `.node` addon. An
  app on the published npm SDK only needs the `serverExternalPackages` list in
  `next.config.ts`.
- Known boundary, surfaced honestly in the approve flow: an approved per-user
  skill lands as a **draft scoped to that end-user** in Cloud;
  `GET /api/v1/catalog` serves only published, global skills, so it won't
  appear in the catalog panel (nor sync to any SDK host) until that gap is
  closed upstream.
- Uncovered asks should share no vocabulary with the seeded skills — BM25
  score ≥ the coverage threshold counts as "covered" and yields an edit
  suggestion instead of a per-user coverage gap.
