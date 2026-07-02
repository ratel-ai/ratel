# `src/cloud/fixtures/`

The **cross-language contract** for Ratel Cloud telemetry. These JSON vectors are the single set of
events the Rust schema crate and both pure-language clients replay, so drift between the mirrors and the
canonical spec fails CI instead of reaching production ([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)).

## Layout

```
valid/      events that must deserialize, pass validation, and round-trip unchanged
invalid/    events that must deserialize but fail validation (one broken rule each)
```

## How they're used

- **`valid/`** is **generated** — it is the output of [`core`'s `dump_fixtures` example](../core/README.md)
  (`cargo run -p ratel-ai-cloud --example dump_fixtures`), so the Rust types are the source of truth.
  A clean `git diff` after running it means the committed fixtures match the schema. Each language's
  conformance suite deserializes every file, validates it, and (in Rust) re-serializes it to confirm a
  lossless round-trip.
- **`invalid/`** is **hand-authored**. Every file is structurally well-formed — so each language's parser
  accepts it — but breaks exactly one semantic rule (empty `provider`, no `messages`, a `tool_call` in a
  user message, non-object tool arguments/parameters, a media block missing its source). Each conformance
  suite asserts `validate` rejects it. Required fields are always present, since the Rust `Event` cannot
  deserialize without them.

The three conformance suites that consume this folder: [`core/tests/conformance.rs`](../core/),
[`ts/src/conformance.test.ts`](../ts/), and [`python/tests/test_conformance.py`](../python/).
