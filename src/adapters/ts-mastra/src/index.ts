/**
 * `@ratel-ai/mastra-adapter` — the Mastra adapter for Ratel. Implements the
 * `@ratel-ai/sdk` framework-adapter SPI (ADR-0013) for `@mastra/core`, so
 * `ratel(config).adaptTo(mastra())` speaks Mastra's native `Tool` (from
 * `createTool`) and `MastraDBMessage` shapes and adds a per-turn recall input
 * processor for an Agent's `inputProcessors`.
 *
 * @packageDocumentation
 */

export { type MastraExt, type MastraTool, mastra } from "./mastra.js";
