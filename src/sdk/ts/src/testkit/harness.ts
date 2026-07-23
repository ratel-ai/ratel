import {
  type AdapterConformanceOptions,
  adapterConformanceCases,
  type ConformanceCase,
} from "./cases.js";

/**
 * The `it`/`test` function shape the harness needs: callable to register a case,
 * with an optional `skip` for cases a framework can't run. Vitest, Jest, and
 * `node:test` all satisfy it structurally.
 */
export interface ConformanceIt {
  /** Register a case under `name`, running `fn` as its body. */
  (name: string, fn: () => void | Promise<void>): void;
  /** Register a case as skipped, if the runner supports it. */
  skip?: (name: string, fn: () => void | Promise<void>) => void;
}

/**
 * The `describe`/`it` pair {@link describeAdapterConformance} registers the
 * battery through — structurally satisfied by Vitest, Jest, and `node:test`.
 */
export interface ConformanceRunner {
  /** Open a group named `name`, running `fn` to register its cases synchronously. */
  describe(name: string, fn: () => void): void;
  /** Register one case (see {@link ConformanceIt}). */
  it: ConformanceIt;
}

/**
 * Register the whole adapter conformance battery as first-class tests in a host
 * runner: one `describe` group per {@link ConformanceCase.area}, one `it` per
 * case. Skipped cases use the runner's `it.skip` when present, else fall back to
 * an `it` whose name carries a `[skipped: …]` suffix so nothing is silently
 * dropped. The convenience wrapper over {@link adapterConformanceCases} — use
 * that directly for a custom harness.
 *
 * @param options - The framework's adapter factory and tool/message hooks.
 * @param runner - The host's `{ describe, it }` (Vitest/Jest/`node:test`).
 *
 * @example
 * ```ts
 * import { describe, it } from "vitest";
 * import { describeAdapterConformance } from "@ratel-ai/sdk/testkit";
 * import { myConformanceOptions } from "./conformance-options.js";
 *
 * describeAdapterConformance(myConformanceOptions(), { describe, it });
 * ```
 */
export function describeAdapterConformance<TTool, TMessage>(
  options: AdapterConformanceOptions<TTool, TMessage>,
  runner: ConformanceRunner,
): void {
  const byArea = new Map<string, ConformanceCase[]>();
  for (const testCase of adapterConformanceCases(options)) {
    const group = byArea.get(testCase.area);
    if (group) group.push(testCase);
    else byArea.set(testCase.area, [testCase]);
  }

  for (const [area, cases] of byArea) {
    runner.describe(`adapter conformance: ${area}`, () => {
      for (const testCase of cases) {
        if (testCase.skipped) {
          const skipName = testCase.name;
          if (runner.it.skip) runner.it.skip(skipName, () => {});
          else runner.it(`${skipName} [skipped: ${testCase.skipped}]`, () => {});
        } else {
          runner.it(testCase.name, () => testCase.run());
        }
      }
    });
  }
}
