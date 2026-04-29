# 12. RFC 8693 token exchange — v1 or v2

Date: 2026-04-29

## Status

Proposed (blocked on design-partner conversation)

## Context

RFC 8693 defines OAuth 2.0 Token Exchange — the mechanism for downscoping or transforming a token (e.g., a broad refresh token) into a per-server, per-scope, time-limited access token. Tier-2 enterprise gateways (IBM ContextForge, Enkrypt) implement it as part of their compliance posture; tier-1 OSS aggregators (MetaMCP et al.) do not.

Per `docs/RATEL_V1_PLAN.md` §6.4 and `docs/RATEL_PHASE_0.md` §6.4, the question is whether this lands in Ratel v1 or defers to v1.1. The acceptance gate in the Phase 0 doc explicitly requires a *design-partner conversation*: "We don't need it yet" is a valid conclusion *if it comes from talking to someone*, not from internal preference.

## Decision

**Pre-decision (default, pending the gating conversation):** defer to v1.1.

Rationale for the default-defer:

- v1's core wedge (telemetry-driven tool selection + auth lifecycle floor) does not depend on RFC 8693.
- Implementing token exchange properly requires server-side issuer/audience management, scope-policy infrastructure, and careful interaction with downstream MCP servers' token-acceptance rules. Non-trivial; expanded scope.
- The tier-1 OSS gateways we're displacing do not ship it, so the absence is not an immediate competitive gap.
- Tier-2 enterprise gateways do ship it, but those are a different audience tier and a different sales conversation. We catch up here when an enterprise design partner makes it a hard requirement.

**This pre-decision is NOT yet ratified.** The Phase 0 acceptance gate requires confirmation from at least one design-partner conversation. Until that conversation happens, this ADR sits as **Proposed**. Promoting to **Accepted** requires either:

1. A documented conversation with a prospective enterprise user/buyer where downscoped tokens were *not* a hard requirement (validates default-defer), or
2. A documented conversation where downscoped tokens *were* a hard requirement — in which case this ADR flips to "ship in v1" and gets re-scoped.

## Consequences

- **Phase 0 cannot fully exit until this conversation happens.** The other 11 ADRs can be merged independently; this ADR remains Proposed and is the only exit-criteria gap. Per the implementation plan's "Off-keyboard action items" section: schedule the conversation in week 1 of Phase 0, not discover it as a blocker on day 5.
- If the default-defer is confirmed, v1 tokens are stored at full scope (whatever the upstream OAuth provider issued); per-MCP-server downscoping is not available. Operators who need downscoping in v1 either (a) configure their upstream OAuth providers to issue narrower tokens, or (b) wait for v1.1.
- If the conversation flips this to "ship in v1," scope expands meaningfully: server needs an issuer endpoint, scope-policy datastore, and downstream-server token-acceptance verification. v1 timeline rebalances accordingly; some other deferred item moves further out.
- This ADR's blocker is also the reason `RATEL_PHASE_0.md`'s exit criteria allow a documented "Proposed with blocker" status for ADR 0012 specifically — the implementation plan codifies this.
