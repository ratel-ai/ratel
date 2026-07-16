import { describe, expect, it } from "vitest";
import { adapterConformanceCases, describeAdapterConformance } from "./index.js";
import { referenceConformanceOptions } from "./reference-adapter.js";

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
