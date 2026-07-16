import { describe, expect, it } from "vitest";
import {
  droppedResult,
  fixedCallId,
  inertIngest,
  lossyIngest,
  namelessAdapter,
  passthroughAlways,
  passthroughNever,
  rawExpose,
  shadowingExtend,
} from "../test-support/broken-adapters.js";
import {
  type AdapterConformanceOptions,
  adapterConformanceCases,
  describeAdapterConformance,
} from "./index.js";
import { type FakeMessage, type FakeTool, referenceConformanceOptions } from "./reference-adapter.js";

// A runner that records every describe/it/it.skip call instead of executing the
// case bodies — so the harness's registration and skip semantics can be asserted
// without running the battery itself.
interface RunnerCall {
  kind: "describe" | "it" | "it.skip";
  name: string;
}
function recordingRunner() {
  const calls: RunnerCall[] = [];
  const it = Object.assign(
    (name: string, _fn?: () => unknown) => {
      calls.push({ kind: "it", name });
    },
    {
      skip: (name: string, _fn?: () => unknown) => {
        calls.push({ kind: "it.skip", name });
      },
    },
  );
  const runner = {
    describe: (name: string, fn: () => void) => {
      calls.push({ kind: "describe", name });
      fn();
    },
    it,
  };
  return { calls, runner };
}

describe("describeAdapterConformance registration", () => {
  it("registers every case as a test, grouped into one describe per area", () => {
    const { calls, runner } = recordingRunner();
    describeAdapterConformance(referenceConformanceOptions(), runner);

    const cases = adapterConformanceCases(referenceConformanceOptions());
    const areas = new Set(cases.map((c) => c.area));
    expect(calls.filter((c) => c.kind === "describe")).toHaveLength(areas.size);
    // The reference wires makePassthroughTool, so nothing is skipped.
    expect(calls.filter((c) => c.kind === "it")).toHaveLength(cases.length);
    expect(calls.some((c) => c.kind === "it.skip")).toBe(false);
  });

  it("skips the passthrough cases with a reason when makePassthroughTool is absent", () => {
    const noPassthrough = { ...referenceConformanceOptions(), makePassthroughTool: undefined };
    const { calls, runner } = recordingRunner();
    describeAdapterConformance(noPassthrough, runner);

    const passthroughCases = adapterConformanceCases(noPassthrough).filter(
      (c) => c.area === "passthrough",
    );
    expect(passthroughCases.length).toBeGreaterThan(0);
    expect(passthroughCases.every((c) => typeof c.skipped === "string")).toBe(true);
    expect(calls.filter((c) => c.kind === "it.skip")).toHaveLength(passthroughCases.length);
  });

  it("falls back to a name suffix when the runner's it has no skip()", () => {
    const noPassthrough = { ...referenceConformanceOptions(), makePassthroughTool: undefined };
    const names: string[] = [];
    const runner = {
      describe: (_n: string, fn: () => void) => fn(),
      it: (n: string) => {
        names.push(n);
      },
    };
    describeAdapterConformance(noPassthrough, runner);
    expect(names.some((n) => /\[skipped:/.test(n))).toBe(true);
  });
});

// The green path: the reference adapter passes the whole battery, run as
// first-class tests in this suite.
describeAdapterConformance(referenceConformanceOptions(), { describe, it });

// Run every non-skipped case, recording whether it passed — so a broken adapter
// variant can be shown to fail exactly the cases that target its defect while
// unrelated cases stay green.
async function runOutcomes<TTool, TMessage>(
  options: AdapterConformanceOptions<TTool, TMessage>,
): Promise<Map<string, boolean>> {
  const outcomes = new Map<string, boolean>();
  for (const testCase of adapterConformanceCases(options)) {
    if (testCase.skipped) continue;
    try {
      await testCase.run();
      outcomes.set(testCase.name, true);
    } catch {
      outcomes.set(testCase.name, false);
    }
  }
  return outcomes;
}

function expectOutcome(outcomes: Map<string, boolean>, name: string, passed: boolean): void {
  expect(outcomes.has(name), `case "${name}" is in the battery`).toBe(true);
  expect(outcomes.get(name), `case "${name}" ${passed ? "passes" : "fails"}`).toBe(passed);
}

describe("the battery discriminates against broken adapters", () => {
  const withAdapter = (
    adapter: AdapterConformanceOptions<FakeTool, FakeMessage>["adapter"],
  ): AdapterConformanceOptions<FakeTool, FakeMessage> => ({
    ...referenceConformanceOptions(),
    adapter,
  });

  it("lossyIngest fails discovery of ingested tools", async () => {
    const outcomes = await runOutcomes(withAdapter(lossyIngest));
    expectOutcome(outcomes, "runs discovery and invocation through the framework shape", false);
    expectOutcome(outcomes, "discovers tools registered after expose()", false);
    expectOutcome(outcomes, "requires a non-empty adapter name", true);
  });

  it("inertIngest fails execution through the framework executor", async () => {
    const outcomes = await runOutcomes(withAdapter(inertIngest));
    expectOutcome(outcomes, "invokes an ingested tool through the framework executor", false);
    expectOutcome(outcomes, "runs discovery and invocation through the framework shape", false);
    expectOutcome(outcomes, "requires a non-empty adapter name", true);
  });

  it("passthroughAlways fails catalog registration", async () => {
    const outcomes = await runOutcomes(withAdapter(passthroughAlways));
    expectOutcome(outcomes, "registers an ingested tool into the shared catalog", false);
    expectOutcome(outcomes, "invokes an ingested tool through the framework executor", false);
    expectOutcome(outcomes, "requires a non-empty adapter name", true);
  });

  it("passthroughNever fails the passthrough semantics", async () => {
    const outcomes = await runOutcomes(withAdapter(passthroughNever));
    expectOutcome(outcomes, "exposes a passthrough by identity and never catalogs it", false);
    expectOutcome(outcomes, "keeps passthroughs per view", false);
    expectOutcome(outcomes, "first registration wins across executables and passthroughs", false);
    expectOutcome(outcomes, "needs a re-expose to surface a late passthrough", false);
    expectOutcome(outcomes, "registers an ingested tool into the shared catalog", true);
  });

  it("rawExpose fails the exposed-tool shape check", async () => {
    const outcomes = await runOutcomes(withAdapter(rawExpose));
    expectOutcome(outcomes, "exposes exactly the three capability tools, fresh each call", false);
    expectOutcome(outcomes, "requires a non-empty adapter name", true);
  });

  it("fixedCallId fails monotonic ids but not the first pair", async () => {
    const outcomes = await runOutcomes(withAdapter(fixedCallId));
    expectOutcome(outcomes, "mints monotonic ids shared across views", false);
    expectOutcome(outcomes, "returns the adapter's pair with call id recall_0", true);
  });

  it("droppedResult fails recall-pair shape validation", async () => {
    const outcomes = await runOutcomes(withAdapter(droppedResult));
    expectOutcome(outcomes, "returns the adapter's pair with call id recall_0", false);
    expectOutcome(outcomes, "mints monotonic ids shared across views", false);
    expectOutcome(outcomes, "builds the pair for a skills-only match", false);
    expectOutcome(outcomes, "registers an ingested tool into the shared catalog", true);
  });

  it("shadowingExtend fails the base-surface guard", async () => {
    const outcomes = await runOutcomes(withAdapter(shadowingExtend));
    expectOutcome(outcomes, "keeps the base surface intact under extend", false);
    expectOutcome(outcomes, "requires a non-empty adapter name", true);
  });

  it("namelessAdapter fails the adapter-name guard", async () => {
    const outcomes = await runOutcomes(withAdapter(namelessAdapter));
    expectOutcome(outcomes, "requires a non-empty adapter name", false);
    expectOutcome(outcomes, "registers an ingested tool into the shared catalog", true);
  });
});
