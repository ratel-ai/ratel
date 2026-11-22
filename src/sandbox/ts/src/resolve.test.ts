import { describe, expect, it } from "vitest";
import { SandboxParamError, sandbox } from "./index.js";
import { resolveParams } from "./resolve.js";
import { labelDefaults, labelSandbox } from "./test-support/label.sandbox.js";

describe("resolveParams", () => {
  it("returns the defaults, the bare model ID and no overrides without overrides", () => {
    const r = resolveParams(labelSandbox, {});
    expect(r.raw).toEqual(labelDefaults);
    expect(r.values).toEqual({ ...labelDefaults, model: "claude-sonnet-5-5" });
    expect(r.overrides).toEqual([]);
  });

  it("applies an override and names the changed param", () => {
    const r = resolveParams(labelSandbox, { maxTokens: 100 });
    expect(r.values.maxTokens).toBe(100);
    expect(r.overrides).toEqual(["maxTokens"]);
  });

  it("does not count an override equal to the default as a change", () => {
    expect(resolveParams(labelSandbox, { maxTokens: 400 }).overrides).toEqual([]);
  });

  it("gives the same config hash as the defaults object when nothing changes", async () => {
    const { configHash } = await import("./hash.js");
    expect(resolveParams(labelSandbox, {}).configHash).toBe(configHash(labelDefaults));
    expect(resolveParams(labelSandbox, { maxTokens: 100 }).configHash).not.toBe(
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
      resolveParams(labelSandbox, overrides as Record<string, unknown>);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxParamError);
      const e = err as SandboxParamError;
      expect(e.reason).toBe("invalid_params");
      expect(e.sandboxId).toBe("workflow-label");
      expect(e.errors).toEqual([{ param, message: expect.stringMatching(message) }]);
      expect(e.message).toContain("workflow-label");
      expect(e.message).toContain(param);
    }
  });

  it("checks enum, bool, number, string and model options", () => {
    const t = sandbox("scalars", {
      params: {
        model: sandbox.model("anthropic/a", { options: ["anthropic/a", "anthropic/b"] }),
        tone: sandbox.enum("friendly", ["friendly", "terse"]),
        verbose: sandbox.bool(false),
        temperature: sandbox.number(0.2, { min: 0, max: 2 }),
        sig: sandbox.string("x", { maxLength: 3 }),
      },
      input: sandbox.structured<Record<string, never>>({ type: "object" }),
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
    expect(bad).toThrow(SandboxParamError);
    try {
      bad();
    } catch (err) {
      expect((err as SandboxParamError).errors.map((e) => e.param)).toEqual([
        "model",
        "tone",
        "verbose",
        "temperature",
        "sig",
      ]);
    }
  });

  it("passes the model through the sandbox's own resolve", () => {
    const t = sandbox("custom", {
      params: { model: sandbox.model("jev/jev-1.13.0") },
      input: sandbox.structured<Record<string, never>>({ type: "object" }),
      resolve: (id) => ({ engine: id }),
      run: async ({ params }) => params.model.engine,
    });
    expect(resolveParams(t, {}).values.model).toEqual({ engine: "jev/jev-1.13.0" });
  });

  it("resolves per call and never mutates the sandbox", () => {
    resolveParams(labelSandbox, { maxTokens: 100 });
    expect(resolveParams(labelSandbox, {}).values.maxTokens).toBe(400);
    expect(labelSandbox.params.maxTokens.default).toBe(400);
  });
});

describe("sandbox", () => {
  it("rejects an invalid sandbox id and a default outside its own constraints", () => {
    const input = sandbox.structured<Record<string, never>>({ type: "object" });
    expect(() => sandbox("Bad Id", { params: {}, input, run: async () => null })).toThrow(
      /sandbox id/,
    );
    expect(() =>
      sandbox("t", { params: { n: sandbox.int(1, { min: 5 }) }, input, run: async () => null }),
    ).toThrow(/t: n default: must be at least 5/);
  });
});

describe("an async resolve", () => {
  it("leaves no unhandled rejection when only the hash is read", async () => {
    const { sandbox } = await import("./index.js");
    const t = sandbox("async-probe", {
      params: { model: sandbox.model("anthropic/claude-sonnet-5-5") },
      input: sandbox.structured({ type: "object" }),
      resolve: async () => {
        throw new Error("no key");
      },
      run: () => null,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const { configHash, values } = resolveParams(t, {});
    expect(configHash).toMatch(/^[0-9a-f]{64}$/);
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    await expect(values.model).rejects.toThrow("no key");
  });
});
