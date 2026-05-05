import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../types.js";
import { buildControlBaselineBundle, descriptor } from "./control-baseline.js";

const pool: ToolSpec[] = [
  {
    id: "fs.read_file",
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: { type: "object" },
  },
  {
    id: "fs.write_file",
    name: "write_file",
    description: "Write contents to a file.",
    input_schema: { type: "object" },
  },
];

describe("control-baseline descriptor", () => {
  it("declares the canonical id and label", () => {
    expect(descriptor.id).toBe("control-baseline");
    expect(descriptor.label).toBe("control (baseline)");
  });
});

describe("buildControlBaselineBundle", () => {
  it("registers every spec in the pool, no filtering, no gateway", () => {
    const bundle = buildControlBaselineBundle({ pool });
    expect(bundle.activeToolIds.sort()).toEqual(["fs.read_file", "fs.write_file"]);
    expect(bundle.tools.search_tools).toBeUndefined();
    expect(bundle.tools.invoke_tool).toBeUndefined();
  });
});
