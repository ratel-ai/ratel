"""Contract-against-the-pin tests for the ratel.* telemetry vocabulary.

Each constant is asserted against the vocabulary pinned in ../CONVENTIONS.md.
"""

from ratel_ai_telemetry import (
    EXECUTE_TOOL,
    RATEL_AUTH_FLOW,
    RATEL_SEARCH,
    RATEL_SKILL_LOAD,
    RATEL_UPSTREAM_REGISTER,
    SEMCONV_VERSION,
)


def test_pins_the_otel_gen_ai_semconv_version() -> None:
    assert SEMCONV_VERSION == "1.42.0"


def test_names_the_ratel_spans_per_the_pin() -> None:
    assert RATEL_SEARCH == "ratel.search"
    assert RATEL_SKILL_LOAD == "ratel.skill.load"
    assert RATEL_UPSTREAM_REGISTER == "ratel.upstream.register"
    assert RATEL_AUTH_FLOW == "ratel.auth.flow"


def test_tool_invocation_is_gen_ai_execute_tool_not_ratel_invoke() -> None:
    assert EXECUTE_TOOL == "execute_tool"
    assert EXECUTE_TOOL != "ratel.invoke"
