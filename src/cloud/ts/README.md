<div align="center">
  <h1>@ratel-ai/cloud</h1>
  <h4>Pure-TypeScript client for Ratel Cloud telemetry — send agent events to a remote endpoint</h4>
  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="https://discord.gg/ratel-ai">Discord</a>
  </p>
  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/cloud"><img alt="npm" src="https://img.shields.io/npm/v/@ratel-ai/cloud?color=e57300"></a>
    <a href="../../../LICENSE.md"><img alt="License" src="https://img.shields.io/badge/license-MIT-e57300"></a>
  </p>
</div>

Send **agent events** — the request/response of a single LLM call (model, messages, tools, sampling
params, token usage, finish reason) — to a remote Ratel endpoint. You populate one unified shape
([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)); the client validates, batches,
and ships it best-effort without ever blocking or throwing into your app.

Pure TypeScript, no native addon — runs anywhere, including **edge runtimes** (Vercel Edge, Cloudflare
Workers). The event schema mirrors the canonical [`ratel-ai-cloud` Rust crate](../core/README.md), kept
honest by the shared [conformance fixtures](../fixtures/).

## Install

```bash
pnpm add @ratel-ai/cloud
# or: npm install @ratel-ai/cloud
```

Requires Node ≥ 20 (for global `fetch`) or any runtime with a `fetch` implementation.

## Quickstart

```ts
import { RatelCloud } from "@ratel-ai/cloud";

const cloud = new RatelCloud({
  endpoint: "https://cloud.ratel.ai/api/v1/events",
  apiKey: "rtl_...",
});

cloud.sendEvent({
  provider: "openai",
  model: "gpt-5.5",
  ts: new Date().toISOString(),
  stream: false,
  messages: [{ role: "user", content: "Weather in Paris?" }],
  usage: { input_tokens: 82, output_tokens: 41 },
  finish_reason: "stop",
});

await cloud.close(); // flush anything queued
```

`sendEvent` validates and enqueues without awaiting the network. Batches flush on a timer, on reaching
`batchSize`, or via `await cloud.flush()`.

## API

- **`sendEvent(event)`** — validate (unless `validateEvents: false`) and enqueue. `ts` may be omitted
  (the client stamps the current time; override the clock with the `now` option); pass it explicitly
  for replayed/backfilled events. Invalid events are dropped and reported via `onError`. Never blocks
  or throws.
- **`flush()`** — drain the queue in `batchSize`-bounded requests (`MAX_BATCH` = 500).
- **`close()`** — stop the timer and flush.
- **`validate(event)`** — the standalone validator, returning `{ ok }` or `{ ok: false, issues }`.
- **`sendEventBatch(events, opts)`** — the stateless transport, if you want to manage batching yourself.

## Local check against the endpoint

There's no public mock server; to exercise the wire path locally, point `endpoint` at a throwaway
handler (e.g. a one-line `Bun.serve` / Express route that returns `202 { accepted: n }`) and watch the
batched POST arrive with `Authorization: Bearer <key>`. Live ingestion lands once the endpoint adopts
the ADR-0013 schema.

## Build & test

```bash
pnpm build      # tsc
pnpm typecheck  # tsc --noEmit
pnpm lint       # biome check src
pnpm test       # vitest run (incl. conformance against ../fixtures)
```

## Package shape

```
src/
  types.ts       canonical event types (mirror of the Rust schema)
  validate.ts    semantic validation → { ok } | { ok: false, issues }
  transport.ts   fetch batch POST with retry/backoff (sendEventBatch)
  client.ts      RatelCloud — non-blocking sendEvent / flush / close
```
