# `@ratel-ai/cloud`

Ship Ratel usage analytics to your dashboard. The cloud client for [`@ratel-ai/sdk`](../../sdk/ts): it batches the *usage rollups* the SDK assembles and POSTs them to `{host}/api/v1/events` — the exact shape Ratel's cloud dashboard renders. Best-effort, never throws into your code, and a no-op without an API key.

Design: [ADR-0013](../../../docs/adr/0013-observability-and-analytics.md).

## Install

```bash
npm install @ratel-ai/cloud
```

## Usage

`RatelClient` is env-configured (`RATEL_API_KEY`, `RATEL_HOST` — default `https://cloud.ratel.sh`). Call `track(...)` once per agent interaction with the per-source token spend; everything but `tokensByCategory` is optional. The rollup is assembled by `@ratel-ai/sdk`'s `buildRollup` (token / cost maths from `ratel-ai-core`).

```ts
import { RatelClient } from "@ratel-ai/cloud";

const client = new RatelClient(); // env-configured; no-op without RATEL_API_KEY

client.track({
  tokensByCategory: { skills: 120, tools: 2000, history: 3400, memory: 260, user_input: 340 },
  savedByCategory: { tools: 7200 }, // optional: kept out of the prompt this run
  model: "claude-sonnet-4-6",
  outputTokens: 180,
});

await client.flush(); // send everything buffered
```

`track()` buffers and auto-flushes once `flushAt` rollups accrue (or `flushIntervalMs` after the last call); `flush()` sends the rest; `shutdown()` stops background flushing and ships what's left. The send is best-effort — a failed POST is dropped, never surfaced into your code. Retries 5xx, drops 4xx, samples by `sampleRate`, and flushes on process exit.

For a process-wide singleton, use `getClient()` / `configure(options)`.

## API

- `new RatelClient(options?)` / `RatelClientOptions` — `apiKey`, `host`, `enabled`, `sampleRate`, `flushAt`, `flushIntervalMs`, `timeoutMs`, `transport`.
- `client.track(input)` · `client.flush()` · `client.shutdown()` · `client.canExport`.
- `getClient()` · `configure(options)` · `setGlobalClient(client)`.

Rollup assembly (`buildRollup`), the `Transport` seam, and the `TrackInput` / `Rollup` / `SourceTokens` types live in [`@ratel-ai/sdk`](../../sdk/ts).
