"""Consumer-facing mypy contract for registry constructors and registration."""

import subprocess
import sys
from pathlib import Path

_FIXTURES = Path(__file__).with_name("typecheck")


def _run_mypy(name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "mypy",
            "--strict",
            "--no-error-summary",
            str(_FIXTURES / name),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def test_registry_consumer_valid_calls_typecheck() -> None:
    result = _run_mypy("registry_api_valid.py")
    assert result.returncode == 0, result.stdout + result.stderr


def test_registry_consumer_invalid_calls_are_rejected() -> None:
    result = _run_mypy("registry_api_invalid.py")
    output = result.stdout + result.stderr
    assert result.returncode == 1, output
    assert output.count(": error:") == 12, output
