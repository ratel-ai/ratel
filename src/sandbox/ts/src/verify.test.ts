import { beforeAll, describe, expect, it } from "vitest";
import type { Sandbox } from "./sandbox.js";
import { supportSandbox } from "./test-support/support.sandbox.js";
import ignoredSandbox from "./test-support/verify-project/agents/ignored.sandbox.js";
import labelSandbox, { EXAMPLE } from "./test-support/verify-project/agents/label.sandbox.js";
import { type VerifyOptions, type VerifyRow, verifySandbox } from "./verify.js";
import { installVerifyTracing, type VerifyTracing } from "./verify-tracing.js";

let tracing: VerifyTracing;

beforeAll(() => {
  tracing = installVerifyTracing();
});

const KEYS = { ANTHROPIC_API_KEY: "set" };

function verify(sandbox: Sandbox, options: Partial<VerifyOptions> = {}) {
  return verifySandbox(sandbox, { input: EXAMPLE, spans: tracing, env: KEYS, ...options });
}

function rowOf(rows: readonly VerifyRow[], param: string): VerifyRow {
  const row = rows.find((r) => r.param === param);
  if (!row) throw new Error(`no row ${param}`);
  return row;
}

describe("verifySandbox on a structured sandbox", () => {
  it("finds each override in the model-call span and the production hash with none", async () => {
    const report = await verify(labelSandbox);
    expect(report.ok).toBe(true);
    expect(report.rows.map((r) => [r.param, r.status])).toEqual([
      ["model", "wired"],
      ["system", "wired"],
      ["maxTokens", "wired"],
      ["config hash", "wired"],
    ]);
    expect(rowOf(report.rows, "model").detail).toBe(
      "gen_ai.request.model = anthropic/claude-haiku-5-5",
    );
    expect(rowOf(report.rows, "maxTokens").detail).toBe("gen_ai.request.max_tokens = 399");
    expect(rowOf(report.rows, "system").detail).toMatch(
      /sentinel seen in span "chat claude-sonnet-5-5"/,
    );
    // No overrides, then one run per param.
    expect(report.runs).toBe(4);
  });

  it("fails and names a prompt param the code ignores", async () => {
    const report = await verify(ignoredSandbox);
    expect(report.ok).toBe(false);
    const row = rowOf(report.rows, "system");
    expect(row.status).toBe("not_wired");
    expect(row.detail).toMatch(/the code ignores system/);
    expect(rowOf(report.rows, "model").status).toBe("wired");
  });

  it("skips the model check with a reason when only one model is callable", async () => {
    const report = await verify(labelSandbox, { env: {} });
    const row = rowOf(report.rows, "model");
    expect(row.status).toBe("skipped");
    expect(row.detail).toMatch(/pass --model/);
    expect(report.ok).toBe(true);
  });

  it("uses --model as the second model", async () => {
    const report = await verify(labelSandbox, { env: {}, model: "anthropic/claude-opus-5-5" });
    expect(rowOf(report.rows, "model").detail).toBe(
      "gen_ai.request.model = anthropic/claude-opus-5-5",
    );
  });

  it("puts a unique sentinel in each prompt override", async () => {
    const seen: string[] = [];
    await verify(labelSandbox, {
      sentinel: (check) => {
        seen.push(check);
        return `sentinel-${check}`;
      },
    });
    expect(seen).toEqual(["system"]);
  });

  it("reports a production hash that differs from the sandbox's defaults", async () => {
    const drifted = { ...labelSandbox, defaults: { ...labelSandbox.defaults, maxTokens: 500 } };
    const report = await verify(drifted as Sandbox);
    const row = rowOf(report.rows, "config hash");
    expect(row.status).toBe("not_wired");
    expect(row.detail).toMatch(/production \(resolveLocal\) gives/);
  });

  it("throws when the run with no overrides fails", async () => {
    await expect(verify(labelSandbox, { input: { workflowId: 1 } })).rejects.toThrow(
      /the run with no overrides failed/,
    );
  });
});

describe("verifySandbox on a sandbox without a model call", () => {
  it("reports each param not wired: there is no model-call span", async () => {
    const { sandbox } = supportSandbox();
    const report = await verify(sandbox as Sandbox, {
      input: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(report.ok).toBe(false);
    expect(rowOf(report.rows, "system").detail).toMatch(/no model-call span/);
    // The run still calls each tool: its mode is on its execute_tool span.
    expect(rowOf(report.rows, "tools.searchDocs")).toMatchObject({
      status: "wired",
      detail: "ratel.tool.mode=real on execute_tool searchDocs",
    });
    // No hint: verify fakes it instead of waiting for a reviewer.
    expect(rowOf(report.rows, "tools.askExpert").kind).toBe("tool (fake)");
  });
});
