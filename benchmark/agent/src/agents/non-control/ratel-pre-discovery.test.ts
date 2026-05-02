import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../types.js";
import { buildRatelPreDiscoveryBundle, descriptor } from "./ratel-pre-discovery.js";

const pool: ToolSpec[] = [
  {
    id: "fs.read_file",
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    id: "mail.send",
    name: "send_email",
    description: "Send an email via SMTP.",
    input_schema: { type: "object", properties: { to: { type: "string" } } },
  },
];

describe("ratel-pre-discovery descriptor", () => {
  it("declares the canonical id and label", () => {
    expect(descriptor.id).toBe("ratel-pre-discovery");
    expect(descriptor.label).toBe("ratel (pre-discovery only)");
  });
});

describe("buildRatelPreDiscoveryBundle", () => {
  it("registers BM25 top-K of the prompt as direct tools", () => {
    const { bundle } = buildRatelPreDiscoveryBundle({
      scenario: { prompt: "read a file from disk" },
      pool,
      topK: 1,
    });
    expect(bundle.activeToolIds).toContain("fs.read_file");
  });

  it("does NOT expose the search_tools / invoke_tool gateway — that's the full arm's job", () => {
    // The whole point of this arm is the ablation: only BM25 pre-fetch, no
    // gateway. If the gateway leaks in, the comparison against ratel-full
    // becomes meaningless.
    const { bundle } = buildRatelPreDiscoveryBundle({
      scenario: { prompt: "read a file from disk" },
      pool,
      topK: 1,
    });
    expect(bundle.tools.search_tools).toBeUndefined();
    expect(bundle.tools.invoke_tool).toBeUndefined();
  });

  it("respects topK — never registers more than topK direct tools", () => {
    const { bundle } = buildRatelPreDiscoveryBundle({
      scenario: { prompt: "read a file from disk" },
      pool,
      topK: 1,
    });
    expect(bundle.activeToolIds.length).toBeLessThanOrEqual(1);
  });
});
