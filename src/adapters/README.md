# `src/adapters/`

Framework adapter packages: one complementary package per host framework that plugs into the `@ratel-ai/sdk` framework-adapter SPI (`ratel(config).adaptTo(adapter)`, [ADR-0013](../../docs/adr/0013-framework-adapter-spi.md)) so Ratel speaks that framework's native tool and message shapes. The core owns all state and guards; each adapter is three pure codecs plus the framework's idioms.

Directories are language-prefixed (`ts-*`, `py-*`) since a framework gets one adapter per SDK language.

## Layout

- `ts-ai-sdk/` — [`@ratel-ai/ai-sdk-adapter`](ts-ai-sdk/README.md): the [Vercel AI SDK](https://sdk.vercel.ai) (`ai@7`) adapter.

## Build & test

Each package is a member of the pnpm workspace; build and test it from the repo root:

```bash
pnpm --filter @ratel-ai/ai-sdk-adapter build
pnpm --filter @ratel-ai/ai-sdk-adapter typecheck
pnpm --filter @ratel-ai/ai-sdk-adapter lint
pnpm --filter @ratel-ai/ai-sdk-adapter test
```
