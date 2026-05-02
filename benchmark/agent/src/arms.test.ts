import { describe, expect, it } from "vitest";
import { buildArm, buildControl, buildHybrid, buildOracle, sanitizeToolName } from "./arms.js";
import type { Scenario, ToolSpec } from "./types.js";

const candidatePool: ToolSpec[] = [
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
];

const scenario: Scenario = {
  id: "test-001",
  prompt: "read a file from disk",
  candidate_pool: [candidatePool[0]],
  gold_tools: ["fs.read_file"],
};

function distractor(id: string, description: string): ToolSpec {
  return { id, name: id, description, input_schema: {} };
}

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
  it("exposes every tool in the expanded pool, keyed by sanitized name", () => {
    const built = buildControl(scenario, candidatePool);
    expect(built.arm).toBe("control");
    expect(built.activeToolIds).toEqual(["fs.read_file", "fs.write_file", "mail.send"]);
    expect(Object.keys(built.tools).sort()).toEqual(["fs_read_file", "fs_write_file", "mail_send"]);
    expect(built.nameToId.get("fs_read_file")).toBe("fs.read_file");
    expect(built.nameToId.get("mail_send")).toBe("mail.send");
    expect(built.catalog).toBeUndefined();
  });

  it("scales with the expanded pool — 50-distractor case", () => {
    const distractors = Array.from({ length: 49 }, (_, i) =>
      distractor(`d${i}`, `distractor ${i}`),
    );
    const pool = [candidatePool[0], ...distractors];
    const built = buildControl(scenario, pool);
    expect(built.activeToolIds).toHaveLength(50);
    expect(built.activeToolIds[0]).toBe("fs.read_file"); // gold first
  });

  it("throws on tool-id collisions after sanitization", () => {
    const collision: ToolSpec[] = [
      { ...candidatePool[0], id: "fs.read_file" },
      { ...candidatePool[0], id: "fs/read_file" },
    ];
    expect(() => buildControl(scenario, collision)).toThrow(/collision/);
  });
});

describe("buildOracle", () => {
  it("exposes only the gold tools, regardless of the expanded pool size", () => {
    const distractors = Array.from({ length: 50 }, (_, i) => distractor(`d${i}`, `noise ${i}`));
    const pool = [candidatePool[0], ...distractors];
    // candidate_pool must carry the gold spec — that's the ingest contract.
    const fullScenario: Scenario = { ...scenario, candidate_pool: [candidatePool[0]] };
    const built = buildOracle(fullScenario);
    expect(built.arm).toBe("oracle");
    expect(built.activeToolIds).toEqual(["fs.read_file"]);
    expect(Object.keys(built.tools)).toEqual(["fs_read_file"]);
    expect(built.nameToId.get("fs_read_file")).toBe("fs.read_file");
    // Distractors in the expanded pool are deliberately ignored.
    expect(pool.length).toBeGreaterThan(built.activeToolIds.length);
  });

  it("respects multi-gold-tool scenarios", () => {
    const multi: Scenario = {
      ...scenario,
      candidate_pool: [candidatePool[0], candidatePool[1]],
      gold_tools: ["fs.read_file", "fs.write_file"],
    };
    const built = buildOracle(multi);
    expect(built.activeToolIds.sort()).toEqual(["fs.read_file", "fs.write_file"]);
  });
});

describe("buildHybrid", () => {
  it("includes the two gateway tools plus top-K hits", () => {
    const built = buildHybrid(scenario, candidatePool, 2);
    expect(built.arm).toBe("hybrid");
    expect(built.tools.search_tools).toBeDefined();
    expect(built.tools.invoke_tool).toBeDefined();
    expect(built.activeToolIds).toContain("fs.read_file");
    expect(built.activeToolIds.length).toBeLessThanOrEqual(2);
    expect(built.catalog).toBeDefined();
  });

  it("populates the catalog with the full expanded pool, even if only top-K become direct tools", () => {
    const built = buildHybrid(scenario, candidatePool, 1);
    expect(built.catalog?.has("fs.read_file")).toBe(true);
    expect(built.catalog?.has("fs.write_file")).toBe(true);
    expect(built.catalog?.has("mail.send")).toBe(true);
  });
});

describe("buildArm dispatcher", () => {
  it("routes by arm name", () => {
    expect(buildArm("control", scenario, candidatePool, 5).arm).toBe("control");
    expect(buildArm("hybrid", scenario, candidatePool, 5).arm).toBe("hybrid");
    expect(buildArm("oracle", scenario, candidatePool, 5).arm).toBe("oracle");
  });
});
