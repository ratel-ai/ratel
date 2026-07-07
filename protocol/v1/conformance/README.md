# `protocol/v1/conformance/`

The executable conformance vectors for the v1 catalog-source contract. They turn the prose in
[`../README.md`](../README.md) into fixed inputs and expected outputs that every catalog source
and SDK loader MUST reproduce, so the contract — not the one closed implementation — stays
normative.

## Layout

- `vectors.json` — the vectors: fixture catalogs and their expected ETags, canonicalization
  invariants, scope-overlay resolutions, `If-None-Match` outcomes, and the secrets-never-sync
  field rule.
- `verify.mjs` — a conformant reference implementation of the ETag / canonicalization
  algorithm, the scope overlay, and the `If-None-Match` matcher, plus the vector runner.

## Running

```bash
node verify.mjs            # assert every committed expectation (CI mode; exits non-zero on drift)
node verify.mjs --update   # recompute the expected ETags and write them back into vectors.json
```

No dependencies — Node's standard library only.

## What the vectors pin

- **`etag`** — for each fixture catalog and scope, the resolved skill ids and the exact ETag.
- **`equalEtags`** — inputs that MUST hash identically: `basic` = `basic-reordered` (skill
  order, object-key order, and `metadata`-key order are all normalized away) = `field-noise`
  (timestamps / status / version / unknown fields are projected out). `scoped-global` =
  `scoped-bob` (empty subject layer) = `scoped-unknown` (unrecognised subject falls back to the
  global layer).
- **`distinctEtags`** — inputs that MUST differ, e.g. `tags-reordered` (array order is
  significant) and `unicode` (raw-UTF-8, byte-ordered `metadata` keys).
- **`inm`** — the conditional-GET matcher: exact, `W/` weak, `*`, comma-lists, an absent
  header, and a cross-scope tag that must miss.
- **`wire`** — the secrets-never-sync rule: a projection emits exactly the seven skill fields,
  and no field whose name looks like a credential may appear on the wire.

## Consuming the vectors from another implementation

An implementation (the managed cloud, a Rust/TS/Python loader, a future server) is conformant
when, for every `etag` vector, it resolves the fixture catalog for the scope and produces the
committed `resolvedIds` and `etag`, and reproduces every `inm` outcome. It does **not** need to
run `verify.mjs` — it reads `vectors.json` and checks against its own code path. `verify.mjs`
is how the committed expectations are generated and kept honest.
