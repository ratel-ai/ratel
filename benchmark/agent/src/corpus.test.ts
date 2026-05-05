import { describe, expect, it } from "vitest";
import { parseScenarios } from "./corpus.js";
import type { Scenario } from "./types.js";

const sample: Scenario = {
  id: "fs-001",
  prompt: "read /etc/hosts",
  candidate_pool: [
    {
      id: "fs.read_file",
      name: "read_file",
      description: "Read a file from disk.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
      output_schema: { type: "object" },
    },
  ],
  gold_tools: ["fs.read_file"],
  judge_criteria: "mentions localhost",
  category: "filesystem",
};

describe("parseScenarios", () => {
  it("returns empty array for empty input", () => {
    expect(parseScenarios("")).toEqual([]);
  });

  it("skips blank lines", () => {
    const line = JSON.stringify(sample);
    const parsed = parseScenarios(`\n${line}\n\n`);
    expect(parsed).toEqual([sample]);
  });

  it("round-trips a scenario", () => {
    const parsed = parseScenarios(JSON.stringify(sample));
    expect(parsed).toEqual([sample]);
  });

  it("parses multiple scenarios", () => {
    const s2: Scenario = { ...sample, id: "fs-002" };
    const parsed = parseScenarios(`${JSON.stringify(sample)}\n${JSON.stringify(s2)}`);
    expect(parsed).toEqual([sample, s2]);
  });

  it("error references the bad line number", () => {
    const valid = JSON.stringify(sample);
    expect(() => parseScenarios(`${valid}\n{ not json`)).toThrow(/line 2/);
  });
});
