import { describe, it, expect } from "vitest";
import { computeCost, PRICING } from "./constants.js";

describe("PRICING", () => {
  it("has gpt-5 pricing", () => {
    expect(PRICING["gpt-5"]).toEqual({ inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 });
  });

  it("has gpt-5-mini pricing (5x cheaper)", () => {
    expect(PRICING["gpt-5-mini"]).toEqual({ inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2.0 });
  });

  it("has gpt-5-nano pricing (25x cheaper)", () => {
    expect(PRICING["gpt-5-nano"]).toEqual({ inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4 });
  });

  it("has gpt-4o pricing", () => {
    expect(PRICING["gpt-4o"]).toEqual({ inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10.0 });
  });

  it("has claude-sonnet-4-5 pricing", () => {
    expect(PRICING["claude-sonnet-4-5-20250929"]).toEqual({ inputPerM: 3.0, cachedInputPerM: 0.3, outputPerM: 15.0 });
  });

  it("has claude-haiku-4-5 pricing", () => {
    expect(PRICING["claude-haiku-4-5-20251001"]).toEqual({ inputPerM: 1.0, cachedInputPerM: 0.1, outputPerM: 5.0 });
  });

  it("has gemini-3-flash-preview pricing", () => {
    expect(PRICING["gemini-3-flash-preview"]).toEqual({ inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 3.0 });
  });

  it("has gemini-3-pro-preview pricing", () => {
    expect(PRICING["gemini-3-pro-preview"]).toEqual({ inputPerM: 2.0, cachedInputPerM: 0.2, outputPerM: 12.0 });
  });

  it("has claude-opus-4-6 pricing", () => {
    expect(PRICING["claude-opus-4-6"]).toEqual({ inputPerM: 5.0, cachedInputPerM: 0.5, outputPerM: 25.0 });
  });
});

describe("computeCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(computeCost(0, 0, 0)).toBe(0);
  });

  it("computes cost with no cached tokens (gpt-5 default)", () => {
    // 1M input @ $1.25 + 1M output @ $10.00 = $11.25
    expect(computeCost(1_000_000, 0, 1_000_000)).toBeCloseTo(11.25, 4);
  });

  it("subtracts cached from input before applying input price", () => {
    // 1M total input, 400k cached → 600k non-cached
    // 600k * $1.25/M + 400k * $0.125/M + 0 output = $0.75 + $0.05 = $0.80
    expect(computeCost(1_000_000, 400_000, 0)).toBeCloseTo(0.8, 4);
  });

  it("computes cost with all token types", () => {
    // 500 input, 200 cached → 300 non-cached input
    // 300 * 1.25/1M + 200 * 0.125/1M + 100 * 10.00/1M
    // = 0.000375 + 0.000025 + 0.001 = 0.0014
    expect(computeCost(500, 200, 100)).toBeCloseTo(0.0014, 6);
  });

  it("computes gpt-5-mini cost (5x cheaper)", () => {
    // 1M input @ $0.25 + 1M output @ $2.00 = $2.25
    expect(computeCost(1_000_000, 0, 1_000_000, "gpt-5-mini")).toBeCloseTo(2.25, 4);
  });

  it("computes gpt-5-nano cost (25x cheaper)", () => {
    // 1M input @ $0.05 + 1M output @ $0.40 = $0.45
    expect(computeCost(1_000_000, 0, 1_000_000, "gpt-5-nano")).toBeCloseTo(0.45, 4);
  });

  it("computes gpt-5-mini cost with cached tokens", () => {
    // 1M total, 400k cached → 600k non-cached
    // 600k * $0.25/M + 400k * $0.025/M + 0 = $0.15 + $0.01 = $0.16
    expect(computeCost(1_000_000, 400_000, 0, "gpt-5-mini")).toBeCloseTo(0.16, 4);
  });

  it("computes gpt-4o cost", () => {
    // 1M input @ $2.50 + 1M output @ $10.00 = $12.50
    expect(computeCost(1_000_000, 0, 1_000_000, "gpt-4o")).toBeCloseTo(12.5, 4);
  });

  it("computes claude-sonnet-4-5 cost", () => {
    // 1M input @ $3.00 + 1M output @ $15.00 = $18.00
    expect(computeCost(1_000_000, 0, 1_000_000, "claude-sonnet-4-5-20250929")).toBeCloseTo(18.0, 4);
  });

  it("computes claude-sonnet-4-5 cost with cached tokens", () => {
    // 1M total, 400k cached → 600k non-cached
    // 600k * $3.00/M + 400k * $0.30/M + 0 = $1.80 + $0.12 = $1.92
    expect(computeCost(1_000_000, 400_000, 0, "claude-sonnet-4-5-20250929")).toBeCloseTo(1.92, 4);
  });

  it("computes gemini-3-flash-preview cost", () => {
    // 1M input @ $0.50 + 1M output @ $3.00 = $3.50
    expect(computeCost(1_000_000, 0, 1_000_000, "gemini-3-flash-preview")).toBeCloseTo(3.5, 4);
  });

  it("computes claude-opus-4-6 cost", () => {
    // 1M input @ $5.00 + 1M output @ $25.00 = $30.00
    expect(computeCost(1_000_000, 0, 1_000_000, "claude-opus-4-6")).toBeCloseTo(30.0, 4);
  });

  it("computes claude-opus-4-6 cost with cached tokens", () => {
    // 1M total, 400k cached → 600k non-cached
    // 600k * $5.00/M + 400k * $0.50/M + 0 = $3.00 + $0.20 = $3.20
    expect(computeCost(1_000_000, 400_000, 0, "claude-opus-4-6")).toBeCloseTo(3.2, 4);
  });

  it("throws on unknown model", () => {
    expect(() => computeCost(1000, 0, 500, "gpt-unknown")).toThrow("Unknown model");
  });
});
