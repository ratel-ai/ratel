# protocol/

The Ratel **catalog-source wire contract**: the compatibility surface a *catalog source*
implements and an SDK *loader* consumes. A source (the managed cloud today, a self-hosted
source or a third-party loader tomorrow) serves a published catalog; an SDK with `RATEL_URL`
set pulls it and runs retrieval locally
([ADR-0003](../docs/adr/0003-catalog-source-interface.md)). It is a product surface, not a
code module, so it lives at the repo top level beside `src/` (per
[ADR-0002](../docs/adr/0002-product-split-kernel-local-cloud.md)).

It is language-agnostic: the shapes here are the contract; the Rust/TS/Python types (and
`@ratel-ai/cloud` / `ratel-ai-cloud`) are implementations of it. Keeping every source an
implementation of this published contract, never a private API, is what keeps a future
self-hosted server cheap to add.

## Layout

- `v1/` — the current major version of the contract. Auth, catalog pull-sync, the wire
  shapes, the error model, and the versioning rules.

## Versioning

Each **major** version is a subfolder (`v1/`, later `v2/`). Additive changes — new optional
fields, new endpoints, new enum members — land **within** the current major; a conforming
client MUST ignore fields it does not recognise. A change that alters an existing shape's
meaning (including the ETag content projection) is **breaking** and opens a new major. The
frozen pieces of each major are listed in that major's README.

The contract versions independently of any implementation: the managed cloud and every loader
depend on it, so a bump is a fleet-wide compatibility event, not tied to a single package's
release.
