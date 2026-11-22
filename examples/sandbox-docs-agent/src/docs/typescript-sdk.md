# TypeScript SDK

Install the SDK and the telemetry vocabulary:

```sh
npm install @ratel-ai/sdk @ratel-ai/telemetry
```

`@ratel-ai/telemetry` holds the attribute names and values (`ratel.*` and the `gen_ai.*` ones Ratel reads). It carries no exporter: you own your OpenTelemetry providers and add an OTLP exporter to Ratel. For the Vercel AI SDK, add `@ratel-ai/vercel-ai-sdk`: it adapts tools and messages for `ai` 5, 6 and 7.
