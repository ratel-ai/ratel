/**
 * `@ratel-ai/vercel-ai-sdk` — the Vercel AI SDK adapter for Ratel. Implements
 * the `@ratel-ai/sdk` framework-adapter SPI (ADR-0013) for `ai@^5 || ^6 || ^7`, so
 * `ratel(config).adaptTo(aiSdk())` speaks the AI SDK's native `Tool` and
 * `ModelMessage` shapes and adds the SDK-idiomatic per-turn recall helpers.
 *
 * @packageDocumentation
 */

export { type AiSdkExt, aiSdk } from "./aisdk.js";
