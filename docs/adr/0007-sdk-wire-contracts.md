# 7. The platform serves the SDK's wire contracts

## Status

Accepted

## Context

Agents reach the platform only through the Ratel SDK: they send what they did and pull what
they should know. The SDK is released from `ratel-ai/ratel-sdk` on its own cadence
([ADR-0002](0002-products-and-repositories.md)), and old SDK versions stay in the field. The
platform must accept them all without a lockstep release.

## Decision

**The SDK owns the wire contracts. The platform implements them and does not change them.**
The public SDK paths (`next.config.ts` rewrites them to `/api/...`):

| Path | Contract |
|---|---|
| `POST /v1/traces`, `POST /v1/logs` | Remote telemetry is stock OpenTelemetry (OTLP, protobuf or JSON) with the SDK's `gen_ai.*` and `ratel.*` attributes. |
| `POST /api/v1/events` | The runtime events lane: the SDK's flattened JSON events. |
| `GET /v1/catalog`, `GET /v2/catalog` | The catalog-source pull: the project's published catalog under a strong ETag, with conditional GET (`304`) and an optional `?scope=<subject>` overlay. |
| `GET /v1/runtime-catalog/overrides` | The definition overlay source: overrides under a strong ETag. |
| `GET`/`PUT /v1/intent-graph` | The intent graph document, stored as the SDK wrote it, with a revision check. |

Each path authenticates with a project API key (Bearer).

**Evolution is additive.** The platform strips unknown fields and stores unexpected values
instead of rejecting them. It never rejects a payload only because the SDK is newer or older.
Conformance vectors pin the shapes (for example `src/lib/catalog/__fixtures__/`), and the
platform tests read them.

**The platform does not reimplement SDK logic.** Where it needs the SDK's behaviour (for
example intent matching in `readings/intent-graph/fold.ts`), it calls the published
`@ratel-ai/sdk` package.

**Telemetry never blocks the agent.** The SDK may drop events under backpressure. The
platform treats every capture as best effort and its pages say so.

## Consequences

- A contract change starts in `ratel-sdk` and is additive. The platform follows in its own
  pull request.
- The platform can deploy at any time without an SDK release, and the reverse.
- Old SDKs keep working. A field the platform does not know yet is kept and ignored.
