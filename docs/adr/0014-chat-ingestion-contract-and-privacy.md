# 14. Chat ingestion — contract, dedup, and privacy

Date: 2026-06-29

## Status

Proposed

Extends [ADR-0013](0013-observability-and-analytics.md).

## Context

Ratel's skill-suggestion product (porting [ratel-mcp #17](https://github.com/ratel-ai/ratel-mcp/pull/17)
from Claude-Code-hook capture to an SDK + cloud model) needs the customer's **agent conversations** to
extract *intents* (what the user keeps asking agents to do), match them against managed skills, and
surface coverage gaps + skill drafts. Conversation **text** is a new data class: ADR-0013's usage
rollups are deliberately PII-free counts, but intents can only be read from words.

Three forces shape the design:

1. **The Rust core stays out.** ADR-0009 and ADR-0013 make `ratel-ai-core` PII-free and network-free —
   it carries "only counts and identity, never prompt/output text," and "the host SDK is a lean
   best-effort shipper." So chat text rides the **SDK→cloud HTTP channel** (a second road beside
   `POST /api/v1/events`), and intent extraction runs **server-side**. The core is never involved; the
   SDK chat feature needs no core change.
2. **Stateless LLMs resend the growing prefix.** Each model call sends the whole conversation so far
   (`[M1] → [M1,A1,M2] → [M1,A1,M2,A2,M3] → …`). Storing per call is O(calls × turns) of duplicate
   text. We must dedup to O(unique turns), and the comparison must be fast even when a project has a
   very large history.
3. **Privacy.** Conversation text is sensitive. Capture is the customer's explicit choice, and Ratel
   redacts before the text is used or shown.

## Decision

**1 — One SDK→cloud channel: `POST {host}/api/v1/chats`.** `Authorization: Bearer <key>`,
`runtime=nodejs`, mirroring `/api/v1/events`. Body is a single object or a JSON array; each item is one
conversation and a slice of its turns:

```jsonc
{
  "conversation_id": "conv-abc123",   // OPTIONAL — stable id removes all grouping ambiguity (recommended)
  "messages": [
    { "role": "user", "content": "where is my order", "seq": 0, "occurred_at": "2026-06-29T09:12:00Z" },
    { "role": "assistant", "content": "let me check", "seq": 1 }
  ],
  "metadata": { "tenant": "acme" }    // optional, non-PII tags
}
```

Caps: ≤100 conversations/request, ≤500 messages total, per-message content ≤32 KB. Response
`202 { "accepted": <n>, "deduped": <n> }`. `role ∈ {user, assistant, tool, system}`.

**2 — Dedup by content-hash chain → pseudo-sessions.** Each turn is fingerprinted and the fingerprints
are chained:

```
msg_hash[i]    = sha256( role · " " · content )             // role is a fixed enum (space-free), so the delimiter is unambiguous
prefix_hash[i] = sha256( prefix_hash[i-1] · msg_hash[i] )   // fingerprints turns [0..i] in order
```

A `conversations` row (a *pseudo-session*) stores `message_count` + `head_prefix_hash`. Reconciliation
of an incoming slice:

- **Clean extension (O(1)):** if the incoming chain at position `message_count-1` equals the stored
  `head_prefix_hash`, append only `messages[message_count:]`. One hash comparison, no row scan.
- **Diverged** (history pruned/rewritten by context-engineering): walk stored vs incoming `msg_hash`
  for the longest common prefix; append the new tail from the divergence point.
- **Idempotent at the DB:** messages insert `ON CONFLICT (conversation_id, seq) DO NOTHING`.
- **`head_prefix_hash` doubles as the extraction cache key** — Re-analyze is a no-op when unchanged.

**Id-less inference (this product's default).** A `conversation_id` is optional. Without one, the server
computes the incoming prefix-hash chain `P0..P_{k-1}` and probes
`WHERE project_id = ? AND head_prefix_hash = ANY(P0..P_{k-1})` (indexed — never a full scan). The match
at the largest index `j` is the session this call extends (append `messages[j+1:]`); ties break by most
recent `last_message_at`; no match starts a new conversation (`external_id` derived from the head hash).
Supplying a `conversation_id` short-circuits this and removes ambiguity.

**Dedup is server-authoritative.** In v1 the SDK ships the full messages array each call (server-only
dedup) — simplest SDK, stateless-safe. SDK-side delta (a per-conversation cursor sending only new
turns) is a later, additive optimization that does not change this contract.

**3 — Storage: one row per unique turn per conversation.**

```
conversations(
  id uuid pk, project_id uuid fk->projects on delete cascade,
  external_id text not null, metadata jsonb,
  message_count int not null default 0,
  head_prefix_hash text, last_extracted_prefix_hash text,
  started_at timestamptz, last_message_at timestamptz,
  received_at timestamptz not null default now(),
  unique(project_id, external_id), index(project_id, head_prefix_hash)
)
messages(
  id uuid pk, conversation_id uuid fk->conversations on delete cascade,
  role text not null, content text not null, redacted_content text,
  seq integer not null, msg_hash text not null, prefix_hash text,
  occurred_at timestamptz, received_at timestamptz not null default now(),
  unique(conversation_id, seq), index(conversation_id, msg_hash)
)
```

Hash = SHA-256 (zero-dep: Node `crypto` / Python `hashlib`); revisit blake3/xxhash only if profiling
demands. Content-addressed blob offload (store `content` in object storage keyed by `msg_hash`) is a
future scale option, not v1.

**4 — Privacy: opt-in capture, cloud-side redaction.** Chat capture is **off by default**; the SDK
ships content only when the customer enables it. Raw text travels over TLS; the cloud runs a
**server-side redaction pass** filling `redacted_content`, and extraction + the dashboard read the
redacted form. Raw `content` is retained for a bounded window (~30 days) then purged/nulled; the
redacted form and derived intents are kept longer. Per-project, deletable on request. (Usage metrics
remain PII-free and on-by-default per ADR-0013 — chats are the separate, opt-in rich-text channel.)

**5 — Extraction is manual and server-side (RAT-294).** A dashboard "Re-analyze" action drives
extraction over a pseudo-session via the orbitals claim-extractor contract
(`POST {url}/orbitals/claim-extractor/extract`, pluggable endpoint + auth — Principled preview now,
self-hosted later), cached by `head_prefix_hash`. No cron/queue in v1. The core is uninvolved.

## Consequences

- **Storage is O(unique turns), not O(calls × turns)** — the resent prefix is stored once; ingestion is
  one hash-compare in the common case.
- **The core is untouched** — its PII-free, network-free guarantees hold; the SDK chat feature is pure
  `@ratel-ai/cloud` + `ratel_ai` plumbing.
- **Id-less inference lowers customer friction** but adds matching complexity and some grouping
  ambiguity when two sessions share an identical prefix; a supplied `conversation_id` removes it.
- **Clear privacy posture** — opt-in + cloud-side redaction + bounded raw retention gives a defensible
  story for storing conversation text.
- **Manual extraction = no background infrastructure now**; cron/threshold/queue triggers can be added
  later without changing this contract.
- **One hash serves three jobs** — dedup boundary, id-less session matching, and extraction cache key.
