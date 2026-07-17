/**
 * `@ratel-ai/ai-sdk-adapter` — the Vercel AI SDK adapter for Ratel. Implements
 * the `@ratel-ai/sdk` framework-adapter SPI (ADR-0013) for `ai@7`, so
 * `ratel(config).adaptTo(aiSdk())` speaks the AI SDK's native `Tool` and
 * `ModelMessage` shapes and adds the SDK-idiomatic per-turn recall helpers.
 *
 * @packageDocumentation
 */

export { aiSdk } from "./aisdk.js";
