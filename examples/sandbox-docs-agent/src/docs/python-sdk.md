# Python SDK

Install the SDK with pip or uv:

```sh
pip install ratel-ai
uv add ratel-ai
```

The Python package mirrors the TypeScript one. `ratel-ai-telemetry` holds the attribute vocabulary. Wire its span and log record processors into your own OpenTelemetry providers, with the endpoint in `RATEL_OTLP_ENDPOINT` and the key in `RATEL_API_KEY`.
