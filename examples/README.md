# `examples/`

Runnable demos of `@ratel-ai/sdk` wired into real agent frameworks. Each entry is a private workspace package (not published) that depends on `@ratel-ai/sdk` and an external integration.

## Layout

```
ai-sdk/    Ratel + Vercel AI SDK — top-K tool filtering before generateText
```

## Conventions

- Private packages (`"private": true`).
- Pull external integrations (e.g. `ai`, `@ai-sdk/openai`) here, not in `@ratel-ai/sdk`.
- A `start` script that runs the demo end-to-end.
- Each example's README documents the exact env vars (model API keys) and the wiring pattern it illustrates.
