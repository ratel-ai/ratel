# Fix drafts

The drafted text of a fix whose change is a rewrite: a better tool description, or the words
that tell two tools apart. With a ready draft, the eval gate simulates the drafted change
instead of refusing the fix as "nothing to simulate". Ported from upstream `lib/fix-drafts`.

| File | What it holds |
|---|---|
| `schema.ts` | `fix_drafts`: one row per draft of a fix (`drafting`, `ready`, `budget_refused`, `failed`), its change, origin, model and spend. Owned: the fix-drafts partition of the upstream schema hub, column for column, because production already has the table |

The table comes with `jobs_draft_fix_pending_idx` on `jobs` (`lib/jobs/schema.ts`): at most one
queued or running `draft_fix` job per fix.
