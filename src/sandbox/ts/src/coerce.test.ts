import { describe, expect, it } from "vitest";
import { coerceOverride, sandbox } from "./index.js";

describe("coerceOverride", () => {
  it.each([
    [sandbox.int(1), "100", 100],
    [sandbox.number(0.5), "0.25", 0.25],
    [sandbox.bool(false), "true", true],
    [sandbox.bool(true), "false", false],
    [sandbox.enum("a", ["a", "b"]), "b", "b"],
    [sandbox.string("x"), "hello world", "hello world"],
    [sandbox.prompt("p"), "You are terse.", "You are terse."],
    [sandbox.model("anthropic/a"), "anthropic/b", "anthropic/b"],
  ])("turns the CLI text into the param's value", (param, raw, value) => {
    expect(coerceOverride(param, raw)).toEqual(value);
  });

  it("leaves text that is not a number or a bool as text, so the param check names the problem", () => {
    expect(coerceOverride(sandbox.int(1), "many")).toBe("many");
    expect(coerceOverride(sandbox.bool(true), "yes")).toBe("yes");
    expect(coerceOverride(sandbox.int(1), "")).toBe("");
  });
});
