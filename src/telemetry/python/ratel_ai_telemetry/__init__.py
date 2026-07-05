"""`ratel-ai-telemetry` — the ratel.* telemetry vocabulary.

See the wire contract in ../CONVENTIONS.md. Emitting the vocabulary is done through
the standard OpenTelemetry Python SDK; this package adds no transport and no schema
(ADR-0015). The full attribute/enum vocabulary and the init() OTLP builder land in a
later slice; this scaffold pins the semconv version and the span vocabulary.
"""

from __future__ import annotations

from typing import Final

#: The pinned OpenTelemetry semantic-conventions version this vocabulary tracks
#: (the gen_ai group). The pin is the contract; consumers read against this exact
#: version, never "latest" (CONVENTIONS.md § The pin).
SEMCONV_VERSION: Final = "1.42.0"

#: ratel.search — capability search (unifies tool-search and skill-search).
RATEL_SEARCH: Final = "ratel.search"

#: execute_tool — the gen_ai.operation.name value for a tool invocation.
#: Deliberately the standard OTel gen_ai operation, not a bespoke ratel.invoke span,
#: so a generic OTel backend already understands it (locked 2026-07-05). The invoke
#: is enriched with ratel.* attributes.
EXECUTE_TOOL: Final = "execute_tool"

#: ratel.skill.load — skill content load (get_skill_content).
RATEL_SKILL_LOAD: Final = "ratel.skill.load"

#: ratel.upstream.register — upstream-MCP ingest.
RATEL_UPSTREAM_REGISTER: Final = "ratel.upstream.register"

#: ratel.auth.flow — MCP auth flow.
RATEL_AUTH_FLOW: Final = "ratel.auth.flow"

__all__ = [
    "EXECUTE_TOOL",
    "RATEL_AUTH_FLOW",
    "RATEL_SEARCH",
    "RATEL_SKILL_LOAD",
    "RATEL_UPSTREAM_REGISTER",
    "SEMCONV_VERSION",
]
