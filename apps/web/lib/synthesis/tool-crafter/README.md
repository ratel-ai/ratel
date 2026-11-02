# `lib/synthesis/tool-crafter` (L5)

The tool crafter: rule-drafted changes to a project's tools, read off the tool explorer's
latest reading (L4), match quality's replay history and the stored topic patterns. One
`craft_tools` job per pass, queued by every completed explorer run through
`exploreSeams.enqueueCraft` (`readings/tool-explorer/job.ts`) and coalesced to one queued job
per project by the `jobs_craft_tools_queued_idx` partial index (`lib/jobs/schema.ts`). A run
reaps a live run a crashed job left behind, claims the project's one live run, reads, drafts
and backtests, then stores its proposals; the previous run's pending proposals are superseded,
and a dismissed change is never raised again. No model is called anywhere in it: the drafts are
rules over counts, and a run completes with no model key and no network.

| File | Holds |
|---|---|
| `schema.ts` | `tool_craft_runs`, `tool_craft_proposals` |
| `job.ts` | `craftProjectTools`, the job; `parseCraftPayload`; the default reads (`loadExplorerForCraft`, `loadSourcesForCraft`, `loadDeficitsForCraft`, `loadBacktestForCraft`, `loadIntentPatternsForCraft`) |
| `register.ts` | the `craft_tools` job handler; fills `exploreSeams.enqueueCraft` when the registry loads |
| `queries.ts` | the run lifecycle, the coalesced enqueue, the proposals and their review transitions (`listCraftProposals`, `getCraftProposal`, `dismissCraftProposal`) |
| `pipeline.ts` | `runToolCraft`: the reads, the candidate rules in order, drafting, the schema check, the backtest and the dedupe against dismissed changes |
| `candidates.ts`, `intent-merge.ts` | the rules: merges, folds, retirements, compositions, parallel pairs, tightened schemas, enriched responses, preloads, splits, gaps, prerequisites; the intents' own merges from the topic patterns |
| `draft.ts`, `kinds.ts`, `prompt.ts` | one drafted definition per kind, the kind guide and the prompt a person can paste to apply a change by hand |
| `backtest.ts`, `round-trip.ts` | the replay of match quality's cases against the crafted corpus; what one model round trip costs the project (`roundTripPrice`, `NO_PRICE`) |
| `schema-check.ts` | `checkProposal`: names, input schemas, searchable text, within the registry's limits |
| `suggestion-model.ts`, `view.ts`, `export.ts` | the card model (`suggestionView`, `EffectChip`), the evidence facts (`EvidenceFact`) and the export a client applies |
| `types.ts`, `craft-key.ts` | `CRAFT_KINDS`, the proposal body and evidence shapes; the key that makes one change of a kind and its tools |

**Owned files** (`owned` in `scripts/platform-sync/map.json`): `schema.ts`, the tool-crafter
partition of the upstream schema hub; `job.ts`, with no flag gate (the crafter drafts for every
project here, as the explorer runs for every project, so upstream's `flag.ts` and `flags-ingest`
are gone); `job.integration.test.ts`, without the flag cases; and `register.ts`, this
repository's registration. Everything else mirrors upstream.

**Seams.** Loading `register.ts` fills `exploreSeams.enqueueCraft` with
`enqueueCraftJob(projectId, undefined, "chained")`, so L4 never imports this module. The Fixes
page and a task's page read the pending proposals through `fixSeams` and `tasksSeams`
(`lib/views`), filled by a filler in `views` (L6). `lib/views/fixes/crafter-types.ts`
re-exports `CRAFT_KINDS`, `EffectChip`, `EvidenceFact`, `RoundTripPrice` and `NO_PRICE` from
here under the names the fixes model was written against.

Tests: `register.test.ts` (the job kind, the seam fill and the core order), `rules`, `c2`,
`draft`, `pipeline`, `intent-merge`, `schema-check`, `round-trip`, `prompt` (the rules and the
drafts) and `job.integration.test.ts` (on PGlite: a run reads the explorer's always-together
pair and stores a merge and a retirement, a dismissal holds across runs, a later run supersedes,
the intents' merges read the stored topic reading and survive a reading that cannot be read).
The explorer's `timing.test.ts` reads this module's `pairTiming` and `timingSentences`. Run them
with `npx -y node@24 --import tsx --test --test-force-exit lib/synthesis/tool-crafter/*.test.ts`
from `apps/web`.
