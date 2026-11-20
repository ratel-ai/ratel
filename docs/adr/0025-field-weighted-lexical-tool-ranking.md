# 25. Field-weighted lexical tool ranking (experimental BM25F)

Date: 2026-09-16

## Status

Proposed

Extends [ADR-0004](0004-retrieval-and-tool-selection.md) (the stable `searchable_text`
projection and the BM25 scorer over it) and [ADR-0011](0011-selectable-retrieval-methods.md)
(BM25 as the default, model-free ranker). Naming follows
[ADR-0014](0014-adaptive-usage-ranking.md)'s experimental-surface convention.

[ADR-0023](0023-searchable-text-indexes-names-not-schema-prose.md) changed the projection for
every catalog and was reverted on the fixture's evidence. This record takes the shape that
rejection argued for: opt-in per catalog, projection untouched. It feeds
[ADR-0024](0024-hybrid-fuses-on-scores.md)'s score fusion through the same per-query ceiling
as the flattened index.
[Issue #56](https://github.com/ratel-ai/ratel/issues/56) is where this started, and the
measurements below say it is not what #56 needs.

## Context

`searchable_text` flattens a tool's name, description, and schema tokens into one unweighted
document, and BM25 scores that document. Every field competes on the same footing, one `b`
normalizes all of them together, and `push_identifier` pushes a name twice, so names carry a
boost nobody chose and nobody can tune.

Two separable problems live in there. One is that a name and a schema key should not count the
same as authored description text, and a three-token name should not be length-normalized like
free prose. The other is #56: `look for documentation about deployment configuration` ranks
`weather_lookup` (2.1971) above `search_docs` (2.1485) on that catalog.

**Field weighting fixes the first and not the second.** Measured against the twelve-tool
catalog in the issue, with the scorer this record proposes:

| setting | top three |
|---|---|
| flattened, today | weather_lookup 2.1971, search_docs 2.1485, read_env_file 2.1367 |
| field weights | weather_lookup 2.3151, read_env_file 2.0954, search_docs 2.0954 |
| description `b` = 0 | read_env_file 2.1595, search_docs 2.1595, weather_lookup 2.1595 |
| name weight 4.0 | weather_lookup 2.3151, read_env_file 2.0954, search_docs 2.0954 |

Per-term probes return one tool each: `look` to weather_lookup, `documentation` to search_docs,
`deployment` to read_env_file. Each of those terms occurs in exactly one tool of the twelve, so
document frequency is 1 and every IDF is identical. Both decisive terms sit in the same field,
the description, so no weight on name or schema can move them relative to each other. What
separates them is description length alone, which the `b` = 0 row shows directly: remove length
normalization and the three tie exactly.

So #56's capture is a query-side problem — a throwaway verb is as informative as an intent noun
when both appear once — and it stays open after this record. Tool descriptions are catalog
metadata discovered from registration or MCP `tools/list`, so rewriting them at query time is
not a lever either.

The nondeterministic half of #56 is already fixed: `Bm25Index::search` ranks the full corpus and
breaks ties by id.

## Decision

**An experimental BM25F scorer that weights a tool's fields separately, opt-in per catalog,
with the flattened default untouched.**

- **Three fields**: `name` (whole and identifier-split), `description` (the authored one, or the
  ADR-0021 override when present), and `schema` (the ADR-0004 tokens from input and output
  schemas). Each carries a weight `w_f` and its own length normalization `b_f`; `k1` stays
  shared. A short name field wants a lower `b` than free text, which one flat document cannot
  express.
- **Document frequency stays corpus-level.** A term occurring in any field of a tool counts once
  for that tool, so IDF is unchanged and field weights move only the term-frequency side.
- **The weights are tuning, not contract.** The shape is decided here; shipped defaults come
  from a `ratel-bench` sweep, as ADR-0004 treats `k1`/`b`.
- **Entry points are experimental**, per ADR-0014:
  `experimentalEnableFieldWeightedRanking(weights)` /
  `experimental_enable_field_weighted_ranking`, with `disable` and `status` siblings. Off by
  default. When on, it replaces the lexical scorer for that catalog, which is the BM25 method
  and the lexical arm inside hybrid; the dense arm and RRF are untouched.
- **`searchable_text` does not change.** It remains the ADR-0004 contract that telemetry,
  suggestions, dense retrieval, and the embedding cache build on. A private
  `searchable_fields(&Tool)` returns the same tokens already split by field, so the two
  projections cannot drift: one is the concatenation of the other.
- **The name keeps both forms.** Whole and identifier-split both stay in the name field: one
  serves identifier queries, the other natural language. What changes is that their emphasis
  becomes `w_name`, which an operator can tune or turn down, instead of the accidental boost of
  appearing twice in a document shared with every other field.
- **Scoring is computed in-crate.** The `bm25` crate scores one flat document per id, so the
  experimental path reuses its `Tokenizer` (English stemming and stopwords, same vocabulary as
  today) and does its own accumulation, rather than building one engine per field.
- **Fusion sees the same scale.** The field-weighted index answers `query_ceiling` with the
  flattened index's definition, Σ IDF over the query's distinct terms, so ADR-0024 normalises
  either lexical scorer alike. Query terms are deduplicated the same way. `k1` comes from the
  catalog's `Bm25Params`; its `b` is replaced by the per-field values.
- **Ordering is unchanged**: full-corpus rank, `(score desc, id asc)`, then cut to `top_k`.
- **Traces name the stage `bm25f`**, so a run is attributable without reading the catalog
  config.
- **Tools first.** Skills and facts keep the flat projection until this graduates.

Graduation needs no BFCL or SR-Agents regression in `ratel-bench`, as ADR-0021 requires before
its own. Then the prefix drops, or the surface is removed. The #56 catalog is a scenario worth
carrying in the bench either way, as the case this does not fix.

## Consequences

- Callers who do not opt in score byte-for-byte as before, including their embedding artifacts.
- An operator gets a lever over how much a name, a description, and schema keys each count,
  which today is decided for them by how long each field happens to be.
- #56 stays open. Whatever addresses it — query-side handling of generic verbs, or the dense arm
  this catalog was never run against — composes with field weights rather than replacing them.
- Ratel owns a lexical scorer it previously delegated, which is the cost of per-field `b`. The
  tokenizer stays the crate's, so both paths agree on what a term is.
- Field weights are a tuning surface an operator can get wrong, on top of the description text
  they already control.
- The experimental surface may change or disappear without a major bump, per the 0.x rule.

## Rejected

- **Claiming this closes #56**: measured above, it does not. Landing it as the fix would leave a
  closed issue and a live bug.
- **Rewriting or padding descriptions at query time**: they are catalog metadata, and the fix
  belongs in ranking.
- **A query-side stopword or verb list, here**: it may well be what #56 needs, but it is a
  separate decision about query semantics rather than about how a document is indexed.
- **One BM25 index per field, scores added**: each index fits its own `avgdl` and IDF, so the
  per-field scores are not commensurate. RRF across field arms has the same problem in reverse,
  discarding magnitude where these fields differ by degree.
- **Changing `searchable_text`**: ADR-0004 makes it a contract, and every cached embedding
  hashes it.
- **Making field weights the default now**: an unproven ranking change moves every existing
  caller's top-K, which the additive-evolution rule exists to prevent.
