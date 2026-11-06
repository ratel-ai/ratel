# Fix drafts

The drafted text of a fix whose change is a rewrite: a better tool description, or the words
that tell two tools apart. With a ready draft, the eval gate simulates the drafted change
instead of refusing the fix as "nothing to simulate". Ported from upstream `lib/fix-drafts`;
everything runs only when the eval gate is on (`FF_EVAL_GATE`, `eval-gate/gate.ts`).

| File | What it holds |
|---|---|
| `schema.ts` | `fix_drafts`: one row per draft of a fix (`drafting`, `ready`, `budget_refused`, `failed`), its change, origin, model and spend. The fix-drafts partition of the upstream schema hub, column for column, because production already has the table |
| `store.ts` | `latestFixDraft`; `reserveFixDraft` (the $0.05 cap reserved against the organization's daily budget, under `lockOrganizationSpend`); `fixDraftSpendSince` (what drafts spent, the budget reader) |
| `resolve.ts` | `resolveFixChange`: the change a fix makes. A ready draft supplies it; a rewrite or tell-apart with no text queues a `draft_fix` job (one per fix while it waits or runs) and answers "being prepared"; with no model key it says so and queues nothing |
| `model.ts` | the draft model: `claude-sonnet-5-5` (`EVAL_GATE_DRAFT_MODEL`) through `platform/model-call`; `null` with no key (the placeholder key is no key); a deterministic stand-in with `EVAL_GATE_MOCK_MODEL=1` outside production |
| `job.ts` | `draftFixJob` (the `draft_fix` handler: the fix's evidence runs into the match-quality analyst prompt, one model call, the proposals become patches) and `enqueueProjectFixDrafts` |
| `register.ts` | the `draft_fix` registration, and the fills of `evalGateSeams.resolveChange` and `.spendSince` when the module loads |

The table comes with `jobs_draft_fix_pending_idx` on `jobs` (`lib/jobs/schema.ts`): at most one
queued or running `draft_fix` job per fix.

**Owned (ADR-0030).** Every file but `change.test.ts` (copied). The gate reads `env` where
upstream takes organization flag deps; the core has no `organizations` table, so the budget lock
is an advisory lock (`eval-gate/store.ts#lockOrganizationSpend`); `model-call` has no `payer`.
With no model key, upstream would reserve and write a failed draft on each simulation (and with
the placeholder key, send a request); here nothing is queued, reserved, written or sent.
`job.integration.test.ts` adds the no-key, stand-in, seam and index cases.
