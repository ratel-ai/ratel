# `@ratel-ai/cloud`

Ship Ratel usage analytics to your dashboard. The cloud client for [`@ratel-ai/sdk`](../../sdk/ts): it batches the *usage rollups* the SDK assembles and POSTs them to `{host}/api/v1/events` — the exact shape Ratel's cloud dashboard renders. Best-effort, never throws into your code, and a no-op without an API key. It also carries the opt-in **chat channel** — conversation turns shipped to `{host}/api/v1/chats` for server-side intent extraction.

Design: [ADR-0013](../../../docs/adr/0013-observability-and-analytics.md) (analytics), [ADR-0014](../../../docs/adr/0014-chat-ingestion-contract-and-privacy.md) (chat ingestion).

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

## Chat capture (opt-in)

To power Ratel's skill-suggestion product, the client can also ship **conversation turns** to `{host}/api/v1/chats` ([ADR-0014](../../../docs/adr/0014-chat-ingestion-contract-and-privacy.md)). Conversation text is sensitive, so capture is **off by default** — turn it on with `captureChats: true` (or `RATEL_CAPTURE_CHATS=true`). Even then it only ships when an API key is present. Ship the full conversation each call; the server does all dedup.

```ts
const client = new RatelClient({ captureChats: true }); // + RATEL_API_KEY

// Record a slice of one conversation's turns. `seq` defaults to the array index.
client.recordMessages("conv-abc123", [
  { role: "user", content: "where is my order", occurredAt: new Date() },
  { role: "assistant", content: "let me check" },
]);

// Or bind a handle to one conversation id.
const conv = client.trackConversation("conv-abc123");
conv.record([{ role: "user", content: "and refund it" }]);
await conv.flush();
```

Chats batch independently of usage rollups (their own buffer, same `flushAt` / `flushIntervalMs` / retry / never-throws). The wire body is a single object or array of `{ conversation_id, messages: [{ role, content, seq, occurred_at? }], metadata? }`; `role ∈ {user, assistant, tool, system}`.

## API

- `new RatelClient(options?)` / `RatelClientOptions` — `apiKey`, `host`, `enabled`, `sampleRate`, `flushAt`, `flushIntervalMs`, `timeoutMs`, `transport`, `captureChats`, `chatTransport`.
- `client.track(input)` · `client.flush()` · `client.shutdown()` · `client.canExport`.
- `client.recordMessages(conversationId, messages, opts?)` · `client.trackConversation(conversationId)` → `ConversationHandle` (`.record(messages, opts?)` · `.flush()`).
- `getClient()` · `configure(options)` · `setGlobalClient(client)`.
- Chat types: `ChatMessage`, `RecordMessagesOptions`, `ChatPayload` / `ChatWireMessage` (wire shape), `ChatTransport`, `ConversationHandle`.

Rollup assembly (`buildRollup`), the `Transport` seam, and the `TrackInput` / `Rollup` / `SourceTokens` types live in [`@ratel-ai/sdk`](../../sdk/ts).
