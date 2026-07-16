/**
 * `@ratel-ai/sdk/testkit` — the adapter conformance battery. A runner-agnostic
 * set of cases every {@link RatelAdapter} package must pass, covering the whole
 * SPI contract (ADR-0013): ingest/expose round-trip, the reserved-id guard,
 * recall top-K clamping, passthrough semantics, and recall-pair shape. Drive it
 * with {@link describeAdapterConformance} (a `{ describe, it }` from
 * Vitest/Jest/`node:test`) or build the cases yourself with
 * {@link adapterConformanceCases}; assertions use `node:assert`, so no test
 * runner leaks into shipped code. The {@link referenceAdapter} and
 * {@link referenceConformanceOptions} are the worked example a real adapter's
 * options copy.
 *
 * @packageDocumentation
 */

export type {
  AdapterConformanceOptions,
  ConformanceArea,
  ConformanceCase,
  ConformanceToolSpec,
  RecallExpectation,
} from "./cases.js";
export { adapterConformanceCases } from "./cases.js";
export type { ConformanceIt, ConformanceRunner } from "./harness.js";
export { describeAdapterConformance } from "./harness.js";
export type { FakeExt, FakeMessage, FakeTool } from "./reference-adapter.js";
export {
  makeExecutableTool,
  makePassthroughTool,
  referenceAdapter,
  referenceConformanceOptions,
} from "./reference-adapter.js";
