# 11. Auth storage encryption

Date: 2026-04-29

## Status

Accepted

## Context

`ratel-server`'s central token vault (per `docs/RATEL_V1_PLAN.md` §4.2) stores OAuth refresh tokens, PATs, and API keys. These need encryption-at-rest with a posture that meets enterprise floor without forcing a KMS dependency on small-team self-hosters. See `docs/RATEL_PHASE_0.md` §6.3.

Phase 0 research found sparse public documentation for competitor approaches:

- **Enkrypt Secure MCP Gateway** (open repo at `enkryptai/secure-mcp-gateway`) supports OAuth 2.0/2.1 and references KeyDB/local caching, but does not publicly document the at-rest cipher or key-management posture in detail.
- **IBM ContextForge MCP Gateway** documentation is not publicly indexed enough to confirm its encryption-at-rest design.

This is a known research-evidence gap. The approach below mirrors broadly-accepted enterprise patterns (NIST SP 800-38D for AES-GCM, RFC 7539 for ChaCha20-Poly1305) rather than a specific competitor's choice.

## Decision

**v1 floor:** AEAD with a deployment-supplied 32-byte key.

- **Cipher:** AES-256-GCM (default) with ChaCha20-Poly1305 as a runtime-selectable alternative for environments without AES-NI hardware acceleration. Both are AEAD constructions, both are NIST/IETF-blessed, both have well-vetted Rust implementations (`aes-gcm` and `chacha20poly1305` crates from RustCrypto).
- **Key length:** 32 bytes (256-bit). Single key for the v1 floor.
- **Key sourcing:** deployment provides the key as `RATEL_TOKEN_VAULT_KEY` env var (base64-encoded 32 bytes), or via the same vault adapter trait used for fetching application secrets. No KMS in v1.
- **Failure mode if key missing at startup:** **fail fast**. Server refuses to start. We do *not* ship a "encrypt unless key missing" degraded mode — the security implications of silently storing tokens in cleartext are too severe. Operators get a clear error message pointing at the env var or vault adapter.
- **Per-record nonce:** 12-byte random nonce stored alongside ciphertext. Using AES-GCM with random nonces is safe up to ~2³² messages per key (NIST SP 800-38D). Key rotation (below) gives plenty of headroom.
- **Authenticated additional data (AAD):** include the token's stable ID (the upsert key from ADR 0006) as AAD. Prevents ciphertext-substitution attacks within the vault.
- **Key rotation:** v1 supports key rotation as an *operator procedure*, not as automated runtime: operator generates a new key, runs `ratel-cli vault rotate --new-key=<base64>`, the CLI re-encrypts all records under the new key, then operator removes the old key and restarts. The ADR documents the procedure; the actual `vault rotate` CLI command lands in Phase 4.
- **KMS adapter:** explicitly **deferred to v1.1**. Per the no-override-in-v1 stance: the env-var-supplied-key path is the only v1 path. KMS adapter (AWS KMS / GCP KMS / HashiCorp Vault Transit envelope encryption) ships when a design partner asks — same as other deferred extensibility (RATEL_V1_PLAN.md §4.4 embedder, Postgres backend, etc.).

## Consequences

- Single key per deployment. Multi-tenant key segregation is a v1.1 conversation, not a v1 silent-fail surprise.
- The fail-fast behavior is operator-friendly in the long run (no surprise cleartext) but unforgiving on first deploys; the README's "5-minute quickstart" (Phase 4) must surface the env var prominently.
- We avoid taking on cryptography-impl risk by using `aes-gcm` and `chacha20poly1305` from the RustCrypto suite — well-audited, widely-used.
- No KMS dependency means no AWS/GCP SDK in the base server binary. Smaller artifact, faster cold start, fewer transitive deps.
- The `vault rotate` procedure is *manual*. Production key-rotation cadence is an operator concern; v1 doesn't try to automate it. Operators with strict rotation requirements can run `vault rotate` on cron via their own tooling.
- ChaCha20-Poly1305 fallback is for ARM64 deployments without AES-NI hardware acceleration where AES-GCM is significantly slower in software. Detection happens at startup; the choice is logged.
