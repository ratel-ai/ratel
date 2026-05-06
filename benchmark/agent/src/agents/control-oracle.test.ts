import { describe, expect, it } from "vitest";
import type { Scenario, ToolSpec } from "../types.js";
import { buildControlOracleBundle, descriptor } from "./control-oracle.js";

const candidatePool: ToolSpec[] = [
  {
    id: "fs.read_file",
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: { type: "object" },
  },
  {
    id: "fs.write_file",
    name: "write_file",
    description: "Write a file.",
    input_schema: { type: "object" },
  },
  {
    id: "mail.send",
    name: "send_email",
    description: "Send mail.",
    input_schema: { type: "object" },
  },
];

const scenario: Scenario = {
  id: "test-001",
  prompt: "read a file",
  candidate_pool: candidatePool,
  gold_tools: ["fs.read_file"],
};

describe("control-oracle descriptor", () => {
  it("declares the canonical id and label", () => {
    expect(descriptor.id).toBe("control-oracle");
    expect(descriptor.label).toBe("control (oracle)");
  });

  it("opts out of pool-size sweeps — oracle only sees gold tools", () => {
    expect(descriptor.poolSizeAgnostic).toBe(true);
  });
});

describe("buildControlOracleBundle", () => {
  it("exposes only the gold tools, filtered out of candidate_pool", () => {
    const bundle = buildControlOracleBundle({ scenario });
    expect(bundle.activeToolIds).toEqual(["fs.read_file"]);
  });

  it("respects multi-gold-tool scenarios", () => {
    const multi: Scenario = {
      ...scenario,
      gold_tools: ["fs.read_file", "fs.write_file"],
    };
    const bundle = buildControlOracleBundle({ scenario: multi });
    expect(bundle.activeToolIds.sort()).toEqual(["fs.read_file", "fs.write_file"]);
  });

  it("ignores anything in candidate_pool that's not in gold_tools", () => {
    // Distractors leaking through would silently inflate the oracle's success
    // rate and quietly invalidate the upper-bound interpretation.
    const bundle = buildControlOracleBundle({ scenario });
    expect(bundle.activeToolIds).not.toContain("mail.send");
    expect(bundle.activeToolIds).not.toContain("fs.write_file");
  });
});
