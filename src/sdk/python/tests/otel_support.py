"""One OpenTelemetry provider per test session, shared by the modules that read spans or logs.

OpenTelemetry lets a process set the global tracer and logger providers only
once. So no test module sets them at import: the `otel_exporters` fixture in
`conftest.py` calls `install()` on first use, and clears both exporters for
each test. Import this module only after the OpenTelemetry SDK is known to be
installed (`pytest.importorskip`).
"""

from __future__ import annotations

from opentelemetry import _logs, trace
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

SPAN_EXPORTER = InMemorySpanExporter()
LOG_EXPORTER = InMemoryLogRecordExporter()
_installed = False


def install() -> None:
    """Attach the shared exporters to the global providers, setting SDK providers if none is set."""
    global _installed
    if _installed:
        return
    tracer_provider = trace.get_tracer_provider()
    if not isinstance(tracer_provider, TracerProvider):
        tracer_provider = TracerProvider()
        trace.set_tracer_provider(tracer_provider)
    tracer_provider.add_span_processor(SimpleSpanProcessor(SPAN_EXPORTER))
    logger_provider = _logs.get_logger_provider()
    if not isinstance(logger_provider, LoggerProvider):
        logger_provider = LoggerProvider()
        _logs.set_logger_provider(logger_provider)
    logger_provider.add_log_record_processor(SimpleLogRecordProcessor(LOG_EXPORTER))
    _installed = True


def clear() -> None:
    """Drop the spans and logs of earlier tests."""
    SPAN_EXPORTER.clear()
    LOG_EXPORTER.clear()
