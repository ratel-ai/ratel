# 3. Tool selection — replace vs suggest

Date: 2026-04-30

## Status

Accepted

## Context

Ratel's tool-selection module ranks the agent's registered tools per query and has to inject the result into the model call. Two postures are possible:

- **Replace** — Ratel intercepts the tool list before the model call and *replaces* it with its ranked top-K. The model sees only what Ratel selected. More leverage, less compatible with frameworks that bake their own tools into the list.
- **Suggest** — Ratel emits a ranked subset alongside the agent's existing tool list; the integration merges them (or doesn't). More compatible with framework-managed tools, but the agent can ignore Ratel's ranking, blurring the win.

The v0.1.x demo target is "Claude Code consumes fewer input tokens once Ratel is added, with a benchmark backing the claim." The chosen default has to make that claim measurable and clean.

## Decision

**`replace` as the default**; `suggest` will be opt-in later when a framework integration can't reach the replace seam.

The lib will expose both modes as a configurable enum at the public API; framework integrations carry the responsibility of wiring the chosen mode to the framework's actual tool-injection point.

## Consequences

- The headline demo path is unambiguous: one Ratel import → tool list shrinks to top-K → input tokens drop. The benchmark measures exactly this delta.
- `suggest` exists as a compatibility escape hatch for frameworks that own the tool list (e.g., agent-graph runtimes that inject framework-managed tools). It isn't part of the v0.1.x demo.
- Rejected alternative: pick `suggest` as the default. Cleaner compatibility story but it weakens the demo (Ratel's ranking competes with whatever the framework appends), and the token-savings claim becomes harder to attribute.
- Future ADRs may adjust the default per-framework once each integration ships; this ADR sets the project-wide default, not a per-framework matrix.
