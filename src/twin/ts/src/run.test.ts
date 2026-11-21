import { describe, expect, it } from "vitest";
import { runTwin } from "./run.js";
import { labelTwin } from "./test-support/label.twin.js";

describe("runTwin", () => {
  it("calls run with the input, the resolved params and a context", async () => {
    const r = await runTwin(labelTwin, {
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
