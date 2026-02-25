import { describe, it, expect } from "vitest";
import { pickDecoys } from "./decoys.js";

const categories: Record<string, string[]> = {
  alpha: ["a1", "a2", "a3"],
  beta: ["b1", "b2"],
  gamma: ["g1", "g2", "g3", "g4"],
  delta: ["d1", "d2", "d3"],
};

describe("pickDecoys", () => {
  it("returns empty when activeNames already >= minTotal", () => {
    const result = pickDecoys(["a1", "a2", "b1"], categories, 3);
    expect(result).toEqual([]);
  });

  it("returns empty when activeNames > minTotal", () => {
    const result = pickDecoys(["a1", "a2", "b1", "g1"], categories, 3);
    expect(result).toEqual([]);
  });

  it("pads from unrelated categories only", () => {
    // active has alpha tools → decoys should come from beta, gamma, delta
    const result = pickDecoys(["a1", "a2"], categories, 5);
    expect(result).toHaveLength(3);
    for (const name of result) {
      expect(["a1", "a2", "a3"]).not.toContain(name);
    }
  });

  it("excludes all categories occupied by active tools", () => {
    // active spans alpha + gamma → decoys from beta + delta only
    const result = pickDecoys(["a1", "g2"], categories, 6);
    expect(result).toHaveLength(4);
    const alphaOrGamma = ["a1", "a2", "a3", "g1", "g2", "g3", "g4"];
    for (const name of result) {
      expect(alphaOrGamma).not.toContain(name);
    }
  });

  it("is deterministic (sorted categories, sorted tools)", () => {
    const r1 = pickDecoys(["a1"], categories, 6);
    const r2 = pickDecoys(["a1"], categories, 6);
    expect(r1).toEqual(r2);
  });

  it("never includes tools already in activeNames", () => {
    const result = pickDecoys(["b1"], categories, 8);
    expect(result).not.toContain("b1");
  });

  it("caps at available decoy pool size", () => {
    // Only beta(2) + delta(3) = 5 available decoys when alpha+gamma occupied
    const result = pickDecoys(["a1", "g1"], categories, 100);
    expect(result).toHaveLength(5);
  });

  it("handles empty activeNames", () => {
    const result = pickDecoys([], categories, 5);
    expect(result).toHaveLength(5);
  });

  it("handles activeNames not found in any category", () => {
    const result = pickDecoys(["unknown_tool"], categories, 4);
    // unknown tool occupies no category → all categories are available
    expect(result).toHaveLength(3); // 4 - 1 existing = 3 needed
  });
});
