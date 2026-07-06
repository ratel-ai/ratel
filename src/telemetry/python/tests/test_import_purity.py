"""Regression guard for the tree-shakeable split (ADR-0007).

Importing the constants must not pull the OpenTelemetry SDK, so the SDK (emit
side), the server (read side), and edge/serverless emitters take the `ratel.*`
vocabulary weight-free. `init()` lives in the opt-in `ratel_ai_telemetry.otlp`
submodule behind the `[otlp]` extra; plain `import ratel_ai_telemetry` stays clean.
"""

from __future__ import annotations

import subprocess
import sys


def test_importing_the_package_pulls_no_opentelemetry() -> None:
    # A fresh interpreter, so OTel imported by other test modules can't leak in.
    code = (
        "import sys, ratel_ai_telemetry\n"
        "otel = sorted(m for m in sys.modules "
        "if m == 'opentelemetry' or m.startswith('opentelemetry.'))\n"
        "assert not otel, f'constants import pulled OTel: {otel}'\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
