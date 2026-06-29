# Changelog

All notable changes to `@ratel-ai/cloud` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release: **`RatelClient`** — a best-effort, batched cloud analytics client that ships the *usage rollups* assembled by `@ratel-ai/sdk` to `POST {host}/api/v1/events`, the shape Ratel's dashboard renders. Env-configured (`RATEL_API_KEY`, `RATEL_HOST`), a no-op without an API key, never throws; retries 5xx, drops 4xx, samples by `sampleRate`, auto-flushes by size/interval, and flushes on process exit. Extracted from `@ratel-ai/sdk` per [ADR-0013](../../../docs/adr/0013-observability-and-analytics.md).
- `getClient()` / `configure()` / `setGlobalClient()` process-wide singleton helpers, plus `RatelClientOptions`.
- **Opt-in chat capture** ([ADR-0014](../../../docs/adr/0014-chat-ingestion-contract-and-privacy.md)): `recordMessages(conversationId, messages, opts?)` and `trackConversation(conversationId)` ship conversation turns to `POST {host}/api/v1/chats` — a second endpoint beside `/events`, batched on its own buffer with the same retry / never-throws / process-exit-flush semantics. Off by default; enabled with `captureChats: true` or `RATEL_CAPTURE_CHATS`, and only ships when an API key is present. The wire body is a single object or array of `{ conversation_id, messages: [{ role, content, seq, occurred_at? }], metadata? }` (`seq` defaults to the array index); v1 ships the full conversation each call and the server does all dedup. New types: `ChatMessage`, `RecordMessagesOptions`, `ChatPayload`, `ChatWireMessage`, `ChatTransport`, `ConversationHandle`.
