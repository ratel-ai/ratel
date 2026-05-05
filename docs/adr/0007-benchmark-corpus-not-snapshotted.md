# 7. Benchmark corpus is ingested locally, not snapshotted in the repo

Date: 2026-05-02

## Status

Accepted. Supersedes ADR-0006's "snapshot normalized JSONL into the repo" decision and its MetaTool sampling cap. The rest of ADR-0006 (two retrieval modes, programmatic-judge-as-coarse-selection-check, LLM-as-judge primary for mode (c)) stands.

## Context

ADR-0006 decided to commit normalized JSONL snapshots of MetaTool and ToolRet under `benchmark/test-data/`, with MetaTool capped at a sampled subset (1,000 of ~21k queries) "to keep the snapshot small." Two issues surfaced once the harness ran end-to-end:

1. **Snapshots add no value to the developer workflow.** The ingest CLI is one command per corpus (`cargo run … ingest <source> --download`); a clean clone reproduces the JSONL from upstream in seconds. Committing the output buys nothing the ingest CLI doesn't already provide, and creates real costs:
   - **Repo bloat.** ToolRet alone is ~8 MB of JSONL; MetaTool another ~0.5 MB. Both diff opaquely under `git status` whenever a contributor regenerates.
   - **Silent rot.** Upstream MetaTool / ToolRet move; a committed snapshot drifts from the live ingest CLI without anyone noticing until the metrics shift inexplicably.
   - **No stable identity.** The "snapshot" is already a function of `(upstream commit, ingest code)` — two values we already pin. The committed JSONL is a third copy that can disagree with both.
2. **MetaTool sampling existed only to keep the snapshot small.** Capping at 1,000 of ~21k queries was a snapshot-size compromise, not a methodology choice. With no snapshot, the cap throws away signal for no reason — both for mode (a) retrieval metrics and for mode (c)'s eventual end-to-end runs.

## Decision

**Don't snapshot.** Both raw upstream downloads (`benchmark/fixtures/`) and the ingested normalized JSONL (`benchmark/test-data/`) are gitignored. Reproducibility comes from the ingest CLI being deterministic given pinned upstream URLs (no sampling on either corpus, stable id-sorted output).

**Drop MetaTool sampling.** The ingest CLI emits the full upstream query set: 20,630 single-tool + 497 multi-tool queries, modulo the existing skip-on-unknown-gold filter. The `--sample`, `--multi-tool-ratio`, and ingest-time `--seed` flags are removed. Retrieval-time `--seed` for distractor shuffling is unrelated and stays.

**Unified runner.** `pnpm -F @ratel-ai/benchmark run-all` ingests each missing corpus, runs both retrieval modes at corpus-appropriate pool sizes, and renders REPORT.md in one command — so the no-snapshot posture doesn't slow the developer down.

**Folder reorg.** The Rust crate moves to `benchmark/retrieval/` (renamed `ratel-benchmark-retrieval`), making the layout under `benchmark/` self-explanatory: `retrieval/` (Rust, modes a + b) ↔ `agent/` (TS, future mode c). Not strictly required by the corpus-posture flip, but landed together because both touch the same set of paths and READMEs.

## Consequences

- **Smaller, cleaner repo.** No ~8.5 MB of regenerable JSONL under git; `benchmark/test-data/` lives the same gitignored life as `benchmark/results/` and `benchmark/fixtures/`.
- **One source of truth for the corpus.** The ingest CLI + pinned upstream URLs are the spec; the produced JSONL is a build artifact, not a checked-in fact. If upstream moves, the next ingest reflects it without a stale committed file masking the change.
- **Stronger retrieval signal at no cost.** Mode (a) now runs against the full ~21k MetaTool query set instead of a 1k sample. Mode (b) was already full-corpus; unchanged.
- **First-run cost shifts to the developer.** A clean clone now spends a minute or two on `ingest --download` before the first retrieval pass. The unified `run-all` command makes this a single keystroke; the per-mode quickstarts in `benchmark/retrieval/README.md` document the manual path.
- **Test fixtures under `benchmark/test-data/` go away.** The committed `synthetic.jsonl` smoke fixture and `metatool-mini/` integration-test fixture are deleted; the Rust ingest integration test uses inline strings to a temp dir, and the agent CLI's `--corpus` default points at the post-ingest path with a clearer error if absent.
- **ADR-0005 § "Synthetic fixture means CI and contributor onboarding don't need ToolBench access" no longer applies** as written. The current onboarding story is "ingest is one command, no API keys, ~minute"; CI integration (still out of scope per 0005) would either run ingest as part of the job or commit a tiny synthetic fixture under `benchmark/retrieval/tests/fixtures/` if needed.
- **External validation argument unchanged.** Mode (b)'s gold-only pooling caveat from 0006 still stands; absolute nDCG is not directly comparable to ToolRet's leaderboard until the side-loaded full-44k catalog path lands.

## Rejected

- **Commit a smaller MetaTool subset (e.g. 100 rows) as a "stable demo fixture."** Solves nothing the ingest CLI doesn't, and re-introduces the rot risk for a 100-row file that doesn't even drive headline metrics.
- **Pin upstream commit SHAs in code and treat ingest output as canonical.** Adds a layer of pinning we'd then have to keep current; cheaper to track upstream's `master` and let the ingest CLI surface drift on the next run.
- **Keep the snapshot for ToolRet only (since it doesn't sample).** Treating the two corpora differently complicates docs and the unified runner with no offsetting benefit — the bloat case is even stronger for ToolRet (8 MB) than MetaTool.
