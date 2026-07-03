<div align="center">
  <h1>ratel-ai-cloud</h1>
  <h4>Canonical schema for Ratel Cloud telemetry — the spec the language clients mirror</h4>
  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/ratel-ai">Discord</a>
  </p>
  <p>
    <a href="https://crates.io/crates/ratel-ai-cloud"><img alt="crates.io" src="https://img.shields.io/crates/v/ratel-ai-cloud?color=e57300"></a>
    <a href="https://docs.rs/ratel-ai-cloud"><img alt="docs.rs" src="https://img.shields.io/docsrs/ratel-ai-cloud?color=e57300"></a>
    <a href="../../../LICENSE.md"><img alt="License" src="https://img.shields.io/badge/license-MIT-e57300"></a>
  </p>
</div>

The canonical data model for a Ratel Cloud **agent event** — the request/response of a single LLM call.
One unified shape ([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)) the developer
populates, close enough to every provider surface (OpenAI, Anthropic, Vercel) that the transform is
shallow. This crate is the source of truth; the pure-language clients ([`@ratel-ai/cloud`](../ts/),
[`ratel-ai-cloud` for Python](../python/)) mirror it, kept honest by the shared
[conformance fixtures](../fixtures/).

## Library shape

- **Crate name** `ratel-ai-cloud`; **library name** `ratel_ai_cloud`.
- Serde types + strict semantic validation. No I/O, no transport — that lives in the clients.
- A **sibling of `ratel-ai-core`**, with no dependency in either direction: installing telemetry pulls
  zero tool-retrieval code.
- Member of the root Cargo workspace.

## Build & test

```bash
cargo build -p ratel-ai-cloud
cargo test -p ratel-ai-cloud
cargo clippy -p ratel-ai-cloud --all-targets -- -D warnings
# Regenerate the shared valid fixtures from the canonical types (clean git diff = in sync):
cargo run -p ratel-ai-cloud --example dump_fixtures
```

## Schema

[`Event`] is the entire v1 surface: resolved `provider` / `model`, `ts`, `stream`, optional `system`,
`tools`, `messages`, `params`, `usage`, `finish_reason`, and an optional Ratel `savings` facet
(per-source spend and what selection kept out of the prompt — [ADR-0016](../../../docs/adr/0016-cloud-event-savings-facet.md)).
Messages are tagged on `role` (`user` / `assistant` / `tool`); content is a string or a list of typed
[`Block`]s (`text`, `tool_call`, `image`, `file`). Tool-call arguments are a **parsed object**, never a
JSON string.

The schema is **strict but forward-compatible**: there is no escape-hatch bag (the type surface is
closed), but deserialization ignores unknown fields so adding fields later stays non-breaking. Semantic
invariants — non-empty identifiers, tool calls only in assistant messages, object-shaped
arguments/parameters, well-formed media blocks — are enforced by [`validate`], not by wire rejection.

See [ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md) for the full rationale and the
source→canonical mapping table.
