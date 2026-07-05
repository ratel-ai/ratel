/**
 * `@ratel-ai/telemetry` — the `ratel.*` telemetry vocabulary.
 *
 * See the wire contract in `../CONVENTIONS.md`. Emitting the vocabulary is done
 * through the standard OpenTelemetry JS SDK; this package adds no transport and
 * no schema (ADR-0015). The full attribute/enum vocabulary and the `init()` OTLP
 * builder land in a later slice; this scaffold pins the semconv version and the
 * span vocabulary.
 */

/**
 * The pinned OpenTelemetry semantic-conventions version this vocabulary tracks
 * (the `gen_ai` group). The pin is the contract; consumers read against this
 * exact version, never "latest" (CONVENTIONS.md § The pin).
 */
export const SEMCONV_VERSION = "1.42.0";

/** `ratel.search` — capability search (unifies tool-search and skill-search). */
export const RATEL_SEARCH = "ratel.search";

/**
 * `execute_tool` — the `gen_ai.operation.name` value for a tool invocation.
 *
 * Deliberately the standard OTel `gen_ai` operation, not a bespoke `ratel.invoke`
 * span, so a generic OTel backend already understands it (locked 2026-07-05). The
 * invoke is enriched with `ratel.*` attributes.
 */
export const EXECUTE_TOOL = "execute_tool";

/** `ratel.skill.load` — skill content load (`get_skill_content`). */
export const RATEL_SKILL_LOAD = "ratel.skill.load";

/** `ratel.upstream.register` — upstream-MCP ingest. */
export const RATEL_UPSTREAM_REGISTER = "ratel.upstream.register";

/** `ratel.auth.flow` — MCP auth flow. */
export const RATEL_AUTH_FLOW = "ratel.auth.flow";
