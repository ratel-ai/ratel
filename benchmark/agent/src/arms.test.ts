import { describe, expect, it } from "vitest";
import { buildControl, buildHybrid, buildOracle, sanitizeToolName } from "./arms.js";
import type { Scenario } from "./types.js";

const scenario: Scenario = {
  id: "test-001",
  prompt: "read a file from disk",
  candidate_pool: [
    {
      id: "fs.read_file",
      name: "read_file",
      description: "Read a file from disk.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
      output_schema: { type: "object" },
    },
    {
      id: "fs.write_file",
      name: "write_file",
      description: "Write contents to a file.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
      output_schema: { type: "object" },
    },
    {
      id: "mail.send",
      name: "send_email",
      description: "Send an email via SMTP.",
      input_schema: { type: "object", properties: { to: { type: "string" } } },
      output_schema: { type: "object" },
    },
  ],
  gold_tools: ["fs.read_file"],
  gold_trace: [
    {
      tool_id: "fs.read_file",
      args: { path: "/etc/hosts" },
      response: { contents: "127.0.0.1 localhost" },
    },
  ],
};

describe("sanitizeToolName", () => {
  it("leaves ids that already match the provider pattern unchanged", () => {
    expect(sanitizeToolName("read_file")).toBe("read_file");
    expect(sanitizeToolName("search-tools")).toBe("search-tools");
  });

  it("replaces invalid characters with underscores", () => {
    expect(sanitizeToolName("fs.read_file")).toBe("fs_read_file");
    expect(sanitizeToolName("api/v2/get")).toBe("api_v2_get");
    expect(sanitizeToolName("foo:bar baz")).toBe("foo_bar_baz");
  });

  it("trims leading/trailing underscores left over from sanitization", () => {
    expect(sanitizeToolName(".dotted.")).toBe("dotted");
  });

  it("throws when sanitization yields an empty string", () => {
    expect(() => sanitizeToolName("...")).toThrow(/empty/);
  });
});

describe("buildControl", () => {
  it("exposes every tool, keyed by sanitized name, with nameToId mapping back to id", () => {
    const built = buildControl(scenario);
    expect(built.arm).toBe("control");
    expect(built.activeToolIds).toEqual(["fs.read_file", "fs.write_file", "mail.send"]);
    // Dict keys are provider-acceptable function names (no dots).
    expect(Object.keys(built.tools).sort()).toEqual(["fs_read_file", "fs_write_file", "mail_send"]);
    // Reverse mapping is populated so metering can canonicalize the trace.
    expect(built.nameToId.get("fs_read_file")).toBe("fs.read_file");
    expect(built.nameToId.get("mail_send")).toBe("mail.send");
    expect(built.catalog).toBeUndefined();
  });

  it("throws on tool-id collisions after sanitization", () => {
    const collision: Scenario = {
      ...scenario,
      candidate_pool: [
        { ...scenario.candidate_pool[0], id: "fs.read_file" },
        { ...scenario.candidate_pool[0], id: "fs/read_file" },
      ],
    };
    expect(() => buildControl(collision)).toThrow(/collision/);
  });
});

describe("buildOracle", () => {
  it("exposes only the gold tools, keyed by sanitized name", () => {
    const built = buildOracle(scenario);
    expect(built.arm).toBe("oracle");
    expect(built.activeToolIds).toEqual(["fs.read_file"]);
    expect(Object.keys(built.tools)).toEqual(["fs_read_file"]);
    expect(built.nameToId.get("fs_read_file")).toBe("fs.read_file");
  });

  it("respects multi-gold-tool scenarios", () => {
    const multi: Scenario = {
      ...scenario,
      gold_tools: ["fs.read_file", "fs.write_file"],
      gold_trace: [
        ...scenario.gold_trace,
        { tool_id: "fs.write_file", args: { path: "/tmp/a", contents: "x" }, response: {} },
      ],
    };
    const built = buildOracle(multi);
    expect(built.activeToolIds.sort()).toEqual(["fs.read_file", "fs.write_file"]);
  });
});

describe("buildHybrid", () => {
  it("includes the two gateway tools plus top-K hits", () => {
    const built = buildHybrid(scenario, 2);
    expect(built.arm).toBe("hybrid");
    expect(built.tools.search_tools).toBeDefined();
    expect(built.tools.invoke_tool).toBeDefined();
    // BM25 should rank fs.read_file high for "read a file from disk"
    expect(built.activeToolIds).toContain("fs.read_file");
    expect(built.activeToolIds.length).toBeLessThanOrEqual(2);
    expect(built.catalog).toBeDefined();
  });

  it("populates the catalog with the full pool, even though only top-K are direct tools", () => {
    const built = buildHybrid(scenario, 1);
    expect(built.catalog?.has("fs.read_file")).toBe(true);
    expect(built.catalog?.has("fs.write_file")).toBe(true);
    expect(built.catalog?.has("mail.send")).toBe(true);
  });
});
