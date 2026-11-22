import { readFileSync } from "node:fs";
import { sdkSnapshot, withSdkParams } from "@ratel-ai/sandbox";
import { installVerifyTracing, verifySandbox } from "@ratel-ai/sandbox/verify";
import { describe, expect, it } from "vitest";
import declared from "../docs-agent.sandbox.js";

// `ratel sandbox verify docs-agent --input chat.json --dry` in process: a stand-in
// model, no network. The params come from the SDK, as `ratel` loads them.

const docsSandbox = withSdkParams(declared, sdkSnapshot());
const chat = JSON.parse(readFileSync(new URL("../chat.json", import.meta.url), "utf8"));

describe("ratel sandbox verify on the docs agent", () => {
  it("finds each override in the spans of the real reply()", async () => {
    const tracing = installVerifyTracing();
    const report = await verifySandbox(docsSandbox, {
      input: chat,
      spans: tracing,
      dry: true,
      toolChannel: {
        fake: async () => ({ result: { ticketId: "T-dry" }, isError: false, source: "pinned" }),
        confirm: async () => ({ decision: "reject" }),
      },
    });
    expect(Object.fromEntries(report.rows.map((r) => [r.param, r.status]))).toEqual({
      model: "wired",
      system: "wired",
      tools: "wired",
      "tools.searchDocs": "wired",
      "tools.readDoc": "wired",
      "tools.createTicket": "wired",
      // No `defaults` to compare: production reads the same catalog, with no resolveLocal.
      "config hash": "skipped",
    });
    expect(report.ok).toBe(true);
  });

  it("has no declared params: model, system and tools come from the SDK", () => {
    expect(declared.params).toEqual({});
    expect(docsSandbox.sdkParams).toEqual({
      model: { kind: "model", id: "model" },
      system: { kind: "prompt", id: "system" },
      tools: { kind: "tools" },
    });
  });
});
