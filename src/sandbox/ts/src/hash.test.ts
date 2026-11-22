import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, configHash } from "./hash.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,1]},"b":1}',
    );
  });

  it("rejects values JSON cannot carry", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/not a finite number/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/cannot be hashed/);
  });
});

describe("configHash", () => {
  it("is the SHA-256 hex of the canonical JSON", () => {
    const expected = createHash("sha256")
      .update('{"maxTokens":400,"model":"anthropic/x"}')
      .digest("hex");
    expect(configHash({ model: "anthropic/x", maxTokens: 400 })).toBe(expected);
  });

  it("is stable across key order", () => {
    expect(configHash({ a: 1, b: { x: 1, y: 2 } })).toBe(configHash({ b: { y: 2, x: 1 }, a: 1 }));
  });

  it("changes when any param value changes", () => {
    const base = { model: "anthropic/x", system: "s", maxTokens: 400 };
    const h = configHash(base);
    expect(configHash({ ...base, model: "anthropic/y" })).not.toBe(h);
    expect(configHash({ ...base, system: "s " })).not.toBe(h);
    expect(configHash({ ...base, maxTokens: 401 })).not.toBe(h);
  });
});
