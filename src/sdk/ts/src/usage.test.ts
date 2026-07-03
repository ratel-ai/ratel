import { describe, expect, it } from "vitest";
import { estimateCostUsd, estimateTokens } from "./index.js";

// The maths live in `ratel-ai-core` (Rust) and are covered there; these guard that
// the native binding is wired and re-exported from the SDK's public surface.
describe("usage estimation (native binding)", () => {
  it("estimateTokens is ~len/4 and never zero for non-empty text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1); // floor(3/4)=0 -> min 1
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("estimateCostUsd scales with tokens and model tier", () => {
    const opus = estimateCostUsd("claude-opus-4-8", 1_000_000, 0);
    const haiku = estimateCostUsd("claude-haiku-4-5", 1_000_000, 0);
    expect(opus).toBeGreaterThan(haiku);
    expect(opus).toBeCloseTo(15.0, 6);
  });
});
