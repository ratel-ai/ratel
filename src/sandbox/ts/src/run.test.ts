import { describe, expect, it } from "vitest";
import { runSandbox } from "./run.js";
import { labelSandbox } from "./test-support/label.sandbox.js";

describe("runSandbox", () => {
  it("calls run with the input, the resolved params and a context", async () => {
    const r = await runSandbox(labelSandbox, {
      input: { workflowId: "wf", toolOrder: [] },
      overrides: { maxTokens: 100 },
    });
    expect(r.output).toEqual({
      name: "wf:claude-sonnet-5-5:100",
      system: "You name agent workflows.",
    });
    expect(r.overrides).toEqual(["maxTokens"]);
    expect(r.configHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
