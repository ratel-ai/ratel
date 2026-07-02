"""The embedding-model download failure surfaces as a catchable exception (not a
process abort) — the Python mirror of ``src/sdk/ts/src/embedding-errors.test.ts``.
"""

import os
import subprocess
import sys
import tempfile
import textwrap


def test_register_raises_catchable_error_on_download_failure() -> None:
    # Run in a fresh process with a COLD HuggingFace cache and an unreachable
    # endpoint so the first-use model download fails. Isolated in a subprocess so
    # a model already loaded warm in the pytest process can't mask the failure.
    script = textwrap.dedent(
        """
        from ratel_ai import ExecutableTool, ToolCatalog

        catalog = ToolCatalog()
        try:
            catalog.register(
                ExecutableTool(
                    id="t",
                    name="t",
                    description="read a file",
                    input_schema={},
                    output_schema={},
                    execute=lambda args: args,
                )
            )
        except ValueError as exc:
            message = str(exc).lower()
            assert "hint:" in message or "download" in message, message
            print("CAUGHT")
        else:
            raise SystemExit("expected a catchable error, got none")
        """
    )
    env = {
        **os.environ,
        "HF_HOME": tempfile.mkdtemp(),
        "HF_ENDPOINT": "http://127.0.0.1:1",  # connection refused -> fast failure
    }
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert "CAUGHT" in result.stdout, f"stdout={result.stdout!r} stderr={result.stderr!r}"
