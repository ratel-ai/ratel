import { describe, expect, it } from "vitest";
import { coerceOverride, twin } from "./index.js";

describe("coerceOverride", () => {
  it.each([
    [twin.int(1), "100", 100],
    [twin.number(0.5), "0.25", 0.25],
    [twin.bool(false), "true", true],
    [twin.bool(true), "false", false],
    [twin.enum("a", ["a", "b"]), "b", "b"],
    [twin.string("x"), "hello world", "hello world"],
    [twin.prompt("p"), "You are terse.", "You are terse."],
    [twin.model("anthropic/a"), "anthropic/b", "anthropic/b"],
  ])("turns the CLI text into the param's value", (param, raw, value) => {
    expect(coerceOverride(param, raw)).toEqual(value);
  });

  it("leaves text that is not a number or a bool as text, so the param check names the problem", () => {
    expect(coerceOverride(twin.int(1), "many")).toBe("many");
    expect(coerceOverride(twin.bool(true), "yes")).toBe("yes");
    expect(coerceOverride(twin.int(1), "")).toBe("");
  });
});
