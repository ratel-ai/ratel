import { describe, it, expect } from "vitest";
import { skill } from "../skill.js";

describe("skill helper", () => {
  it("normalizes a minimal skill definition", () => {
    const result = skill({
      name: "anomaly_memo",
      description: "Investigate and draft a memo",
      atoms: ["list_transactions", "draft_memo"],
    });
    expect(result).toEqual({
      name: "anomaly_memo",
      description: "Investigate and draft a memo",
      atoms: ["list_transactions", "draft_memo"],
    });
  });

  it("preserves intent, edges, and metadata when present", () => {
    const result = skill({
      name: "anomaly_memo",
      description: "desc",
      intent: "When CFO asks about anomalies",
      atoms: ["a", "b"],
      edges: [{ from: "a", to: "b", source: "developer" }],
      metadata: { team: "finance" },
    });
    expect(result.intent).toBe("When CFO asks about anomalies");
    expect(result.edges).toEqual([{ from: "a", to: "b", source: "developer" }]);
    expect(result.metadata).toEqual({ team: "finance" });
  });

  it("omits optional fields when absent", () => {
    const result = skill({
      name: "x",
      description: "y",
      atoms: ["a"],
    });
    expect(result).not.toHaveProperty("intent");
    expect(result).not.toHaveProperty("edges");
    expect(result).not.toHaveProperty("metadata");
  });
});
