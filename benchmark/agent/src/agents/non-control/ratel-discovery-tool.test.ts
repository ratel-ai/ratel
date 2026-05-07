import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../types.js";
import { buildRatelDiscoveryToolBundle, descriptor } from "./ratel-discovery-tool.js";

const pool: ToolSpec[] = [
  {
    id: "fs.read_file",
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: { type: "object" },
  },
  {
    id: "mail.send",
    name: "send_email",
    description: "Send an email.",
    input_schema: { type: "object" },
  },
];

describe("ratel-discovery-tool descriptor", () => {
  it("declares the canonical id and label", () => {
    expect(descriptor.id).toBe("ratel-discovery-tool");
    expect(descriptor.label).toBe("ratel (discovery-tool only)");
  });
});

describe("buildRatelDiscoveryToolBundle", () => {
  it("exposes only the search_tools / invoke_tool gateway, no direct tools", () => {
    // The arm's whole point is "agent finds tools on its own"; if direct
    // tools leak in, we're measuring the wrong thing. Both gateway tools
    // count toward `activeToolIds` (the catalog column reflects what the
    // agent actually saw, gateway included).
    const { bundle } = buildRatelDiscoveryToolBundle({ pool });
    expect(Object.keys(bundle.tools).sort()).toEqual(["invoke_tool", "search_tools"]);
    expect(bundle.activeToolIds.sort()).toEqual(["invoke_tool", "search_tools"]);
  });

  it("backs the gateway with the full pool", () => {
    // The agent has to be able to find every tool via the gateway; the
    // catalog must therefore hold the full pool, not a subset.
    const { catalog } = buildRatelDiscoveryToolBundle({ pool });
    expect(catalog.has("fs.read_file")).toBe(true);
    expect(catalog.has("mail.send")).toBe(true);
  });
});
