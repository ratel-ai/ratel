import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ExecutableTool, ToolCatalog } from "./index.js";

// Force a COLD HuggingFace cache and an unreachable endpoint so the first-use
// model download fails. This proves the failure surfaces as a **catchable**
// error (with a remediation hint) instead of aborting the whole process — the
// regression that broke CI. Runs in its own vitest worker (forks pool isolates
// per file), so the model is never loaded successfully in this process and the
// env doesn't leak into other suites.
process.env.HF_HOME = mkdtempSync(join(tmpdir(), "ratel-hf-cold-"));
process.env.HF_ENDPOINT = "http://127.0.0.1:1"; // connection refused → fast failure

const tool: ExecutableTool = {
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: {},
  outputSchema: {},
  execute: async () => ({}),
};

describe("embedder load failure", () => {
  it("register throws a catchable error (does not abort the process)", () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.register(tool)).toThrow(/hint:|embedding model|download/i);
  });

  it("search throws a catchable error (does not abort the process)", () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.search("anything", 5)).toThrow(/hint:|embedding model|download/i);
  });
});
