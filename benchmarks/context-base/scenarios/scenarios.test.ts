import { describe, it, expect } from "vitest";
import { scenarios, retrievalScenarios, actionScenarios, multiTurnScenarios, negativeScenarios, ambiguousScenarios, crossDomainScenarios, distractorResistanceScenarios, scaleStressScenarios } from "./index.js";
import type { Scenario, ScenarioType } from "../lib/types.js";
import { toolRegistry } from "../tools/registry.js";
import { flattenSlots } from "../lib/tool-slots.js";

const toolNames = Object.keys(toolRegistry);

describe("scenarios", () => {
  it("exports exactly 40 scenarios", () => {
    expect(scenarios).toHaveLength(40);
  });

  it("has unique ids from 1 to 40", () => {
    const ids = scenarios.map((s) => s.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("has unique seeds", () => {
    const seeds = scenarios.map((s) => s.seed);
    expect(new Set(seeds).size).toBe(40);
  });

  it("skipped scenarios have skip: true", () => {
    const skipped = scenarios.filter((s) => s.skip);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(s.skip).toBe(true);
    }
  });

  it("has non-empty query for every scenario", () => {
    for (const s of scenarios) {
      expect(s.query.length).toBeGreaterThan(0);
    }
  });

  it("references only valid tool names in expectedTools", () => {
    for (const s of scenarios) {
      for (const tool of flattenSlots(s.expectedTools)) {
        expect(toolNames, `scenario #${s.id}: unknown tool "${tool}"`).toContain(tool);
      }
    }
  });

  it("references only valid tool names in expectedParams keys", () => {
    for (const s of scenarios) {
      if (!s.expectedParams) continue;
      for (const tool of Object.keys(s.expectedParams)) {
        expect(toolNames).toContain(tool);
      }
    }
  });

  it("expectedParams keys are a subset of expectedTools (flattened)", () => {
    for (const s of scenarios) {
      if (!s.expectedParams) continue;
      const flat = flattenSlots(s.expectedTools);
      for (const tool of Object.keys(s.expectedParams)) {
        expect(flat, `scenario #${s.id}: expectedParams key "${tool}" not in expectedTools`).toContain(tool);
      }
    }
  });

  describe("category: single-turn retrieval", () => {
    it("exports 8 retrieval scenarios", () => {
      expect(retrievalScenarios).toHaveLength(8);
    });

    it("all have type 'retrieval'", () => {
      for (const s of retrievalScenarios) {
        expect(s.type).toBe("retrieval");
      }
    });

    it("all have at least 1 expected tool", () => {
      for (const s of retrievalScenarios) {
        expect(s.expectedTools.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("none have followUps", () => {
      for (const s of retrievalScenarios) {
        expect(s.followUps).toBeUndefined();
      }
    });
  });

  describe("category: single-turn actions", () => {
    it("exports 7 action scenarios", () => {
      expect(actionScenarios).toHaveLength(7);
    });

    it("all have type 'action'", () => {
      for (const s of actionScenarios) {
        expect(s.type).toBe("action");
      }
    });

    it("all have at least 1 expected tool", () => {
      for (const s of actionScenarios) {
        expect(s.expectedTools.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("all have expectedParams", () => {
      for (const s of actionScenarios) {
        expect(s.expectedParams).toBeDefined();
        expect(Object.keys(s.expectedParams!).length).toBeGreaterThan(0);
      }
    });

    it("none have followUps", () => {
      for (const s of actionScenarios) {
        expect(s.followUps).toBeUndefined();
      }
    });
  });

  describe("category: multi-turn workflows", () => {
    it("exports 5 multi-turn scenarios", () => {
      expect(multiTurnScenarios).toHaveLength(5);
    });

    it("all have type 'multi-turn'", () => {
      for (const s of multiTurnScenarios) {
        expect(s.type).toBe("multi-turn");
      }
    });

    it("all have followUps array", () => {
      for (const s of multiTurnScenarios) {
        expect(s.followUps).toBeDefined();
        expect(s.followUps!.length).toBeGreaterThan(0);
      }
    });

    it("all have at least 3 expected tools", () => {
      for (const s of multiTurnScenarios) {
        expect(s.expectedTools.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe("category: negative / out-of-scope", () => {
    it("exports 3 negative scenarios", () => {
      expect(negativeScenarios).toHaveLength(3);
    });

    it("all have type 'negative'", () => {
      for (const s of negativeScenarios) {
        expect(s.type).toBe("negative");
      }
    });

    it("all have empty expectedTools", () => {
      for (const s of negativeScenarios) {
        expect(s.expectedTools).toEqual([]);
      }
    });
  });

  describe("category: ambiguous", () => {
    it("exports 2 ambiguous scenarios", () => {
      expect(ambiguousScenarios).toHaveLength(2);
    });

    it("all have type 'ambiguous'", () => {
      for (const s of ambiguousScenarios) {
        expect(s.type).toBe("ambiguous");
      }
    });
  });

  describe("category: cross-domain", () => {
    it("exports 5 cross-domain scenarios", () => {
      expect(crossDomainScenarios).toHaveLength(5);
    });

    it("all have type 'retrieval' or 'action'", () => {
      for (const s of crossDomainScenarios) {
        expect(["retrieval", "action"]).toContain(s.type);
      }
    });

    it("all have at least 2 expected tools", () => {
      for (const s of crossDomainScenarios) {
        expect(s.expectedTools.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("category: distractor-resistance", () => {
    it("exports 5 distractor-resistance scenarios", () => {
      expect(distractorResistanceScenarios).toHaveLength(5);
    });

    it("all have type 'retrieval'", () => {
      for (const s of distractorResistanceScenarios) {
        expect(s.type).toBe("retrieval");
      }
    });

    it("all have at least 1 expected tool", () => {
      for (const s of distractorResistanceScenarios) {
        expect(s.expectedTools.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("category: scale-stress", () => {
    it("exports 5 scale-stress scenarios", () => {
      expect(scaleStressScenarios).toHaveLength(5);
    });

    it("all have type 'retrieval'", () => {
      for (const s of scaleStressScenarios) {
        expect(s.type).toBe("retrieval");
      }
    });

    it("all have at least 1 expected tool", () => {
      for (const s of scaleStressScenarios) {
        expect(s.expectedTools.length).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
