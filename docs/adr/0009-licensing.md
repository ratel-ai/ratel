# 9. Licensing: Apache-2.0 kernel, MIT everything else

Date: 2026-07-05

## Status

Accepted

Compacted 2026-07 from pre-compaction ADR-0017 (relicense, 2026-07-04); the relicense was
executed in the product-split restructure (PR #92).

## Context

The kernel is the reusable asset others embed: for a library whose whole point is to ship
inside other products, an explicit **patent grant** is worth more than MIT's terseness, and
it is what downstream legal review expects. Everything else in the repo is thin glue over the
kernel (FFI surfaces, `init()` sugar, examples) living in MIT-dominant ecosystems where
Apache's ceremony buys nothing. We hold the copyright, so relicensing our own future versions
needs no contributor sign-off; already-published versions keep the terms they shipped under.

## Decision

License by component, permissive throughout:

| Component | License |
|---|---|
| `ratel-ai-core` (the kernel crate) | **Apache-2.0** |
| SDKs (`@ratel-ai/sdk`, `ratel-ai`, the native crates) | MIT |
| Telemetry helpers | MIT |
| Examples | MIT |

`LICENSE-APACHE` at the repo root carries the Apache text for the kernel; `LICENSE.md`
carries MIT for the rest; each manifest declares its own `license` field.

**No AGPL, SSPL, BSL, or any source-available / copyleft license anywhere in this repo.**
The value Ratel defends is the managed cloud's intelligence and operations, not a license
moat around OSS components. Copyleft would tax the exact embedded adoption gradient the
product exists to widen. This is revisited only on a demonstrated rehosting threat, by a
superseding ADR; it is not pre-committed.

## Consequences

- Downstream embedders of the kernel get patent protection from its first Apache-2.0
  release; the crate reads as production-ready to legal review.
- The dependency tree is mixed-license and that is fine: an MIT SDK over an Apache-2.0
  kernel is a standard, one-way-compatible combination; nothing is more restrictive than the
  original all-MIT tree for any consumer.
- A third party may legally rehost any OSS component; the bet is that customers pay for the
  managed cloud's intelligence, not for permission.
