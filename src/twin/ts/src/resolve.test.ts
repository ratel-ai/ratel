import { describe, expect, it } from "vitest";
import { TwinParamError, twin } from "./index.js";
import { resolveParams } from "./resolve.js";
import { labelDefaults, labelTwin } from "./test-support/label.twin.js";

describe("resolveParams", () => {
  it("returns the defaults, the bare model ID and no overrides without overrides", () => {
    const r = resolveParams(labelTwin, {});
    expect(r.raw).toEqual(labelDefaults);
    expect(r.values).toEqual({ ...labelDefaults, model: "claude-sonnet-5-5" });
    expect(r.overrides).toEqual([]);
  });

  it("applies an override and names the changed param", () => {
    const r = resolveParams(labelTwin, { maxTokens: 100 });
    expect(r.values.maxTokens).toBe(100);
    expect(r.overrides).toEqual(["maxTokens"]);
  });

  it("does not count an override equal to the default as a change", () => {
    expect(resolveParams(labelTwin, { maxTokens: 400 }).overrides).toEqual([]);
  });

  it("gives the same config hash as the defaults object when nothing changes", async () => {
    const { configHash } = await import("./hash.js");
    expect(resolveParams(labelTwin, {}).configHash).toBe(configHash(labelDefaults));
    expect(resolveParams(labelTwin, { maxTokens: 100 }).configHash).not.toBe(
      configHash(labelDefaults),
    );
  });

  it.each([
    [{ maxTokens: 10 }, "maxTokens", /at least 50/],
    [{ maxTokens: 5000 }, "maxTokens", /at most 2000/],
    [{ maxTokens: 100.5 }, "maxTokens", /integer/],
    [{ maxTokens: "100" }, "maxTokens", /integer/],
    [{ model: "claude-sonnet-5-5" }, "model", /provider\/model/],
    [{ system: 42 }, "system", /string/],
    [{ temperature: 0.2 }, "temperature", /unknown param/],
  ])("rejects %j with invalid_params", (overrides, param, message) => {
    try {
      resolveParams(labelTwin, overrides as Record<string, unknown>);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TwinParamError);
      const e = err as TwinParamError;
      expect(e.reason).toBe("invalid_params");
      expect(e.twinId).toBe("workflow-label");
      expect(e.errors).toEqual([{ param, message: expect.stringMatching(message) }]);
      expect(e.message).toContain("workflow-label");
      expect(e.message).toContain(param);
    }
  });

  it("checks enum, bool, number, string and model options", () => {
    const t = twin("scalars", {
      params: {
        model: twin.model("anthropic/a", { options: ["anthropic/a", "anthropic/b"] }),
        tone: twin.enum("friendly", ["friendly", "terse"]),
        verbose: twin.bool(false),
        temperature: twin.number(0.2, { min: 0, max: 2 }),
        sig: twin.string("x", { maxLength: 3 }),
      },
      input: twin.structured<Record<string, never>>({ type: "object" }),
      run: async () => null,
    });
    expect(
      resolveParams(t, {
        tone: "terse",
        verbose: true,
        temperature: 1.5,
        sig: "abc",
        model: "anthropic/b",
      }).overrides,
    ).toEqual(["model", "tone", "verbose", "temperature", "sig"]);
    const bad = () =>
      resolveParams(t, {
        tone: "rude",
        verbose: "yes",
        temperature: 3,
        sig: "abcd",
        model: "anthropic/c",
      });
    expect(bad).toThrow(TwinParamError);
    try {
      bad();
    } catch (err) {
      expect((err as TwinParamError).errors.map((e) => e.param)).toEqual([
        "model",
        "tone",
        "verbose",
        "temperature",
        "sig",
      ]);
    }
  });

  it("passes the model through the twin's own resolve", () => {
    const t = twin("custom", {
      params: { model: twin.model("jev/jev-1.13.0") },
      input: twin.structured<Record<string, never>>({ type: "object" }),
      resolve: (id) => ({ engine: id }),
      run: async ({ params }) => params.model.engine,
    });
    expect(resolveParams(t, {}).values.model).toEqual({ engine: "jev/jev-1.13.0" });
  });

  it("resolves per call and never mutates the twin", () => {
    resolveParams(labelTwin, { maxTokens: 100 });
    expect(resolveParams(labelTwin, {}).values.maxTokens).toBe(400);
    expect(labelTwin.params.maxTokens.default).toBe(400);
  });
});

describe("twin", () => {
  it("rejects an invalid twin id and a default outside its own constraints", () => {
    const input = twin.structured<Record<string, never>>({ type: "object" });
    expect(() => twin("Bad Id", { params: {}, input, run: async () => null })).toThrow(/twin id/);
    expect(() =>
      twin("t", { params: { n: twin.int(1, { min: 5 }) }, input, run: async () => null }),
    ).toThrow(/t: n default: must be at least 5/);
  });
});
