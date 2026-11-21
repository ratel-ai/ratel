import { installVerifyTracing, verifyTwin } from "@ratel-ai/twin/verify";
import { describe, expect, it } from "vitest";
import docsTwin from "../docs-agent.twin.js";

// `ratel twin verify docs-agent --dry` in process: a stand-in model, no network.

describe("ratel twin verify on the docs agent", () => {
  it("finds each override in the spans of the real reply()", async () => {
    const tracing = installVerifyTracing();
    const report = await verifyTwin(docsTwin, {
      input: docsTwin.example,
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
      maxSteps: "skipped",
      tools: "wired",
      "tools.searchDocs": "wired",
      "tools.readDoc": "wired",
      "tools.createTicket": "wired",
      "config hash": "wired",
    });
    expect(report.ok).toBe(true);
  });
});
