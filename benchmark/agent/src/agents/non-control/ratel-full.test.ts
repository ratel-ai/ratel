import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../types.js";
import { buildRatelFullBundle, descriptor } from "./ratel-full.js";

const pool: ToolSpec[] = [
  {
    id: "fs.read_file",
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    id: "fs.write_file",
    name: "write_file",
    description: "Write contents to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    id: "mail.send",
    name: "send_email",
    description: "Send an email via SMTP.",
    input_schema: { type: "object", properties: { to: { type: "string" } } },
  },
];

describe("ratel-full descriptor", () => {
  it("declares the canonical id and label", () => {
    expect(descriptor.id).toBe("ratel-full");
    expect(descriptor.label).toBe("ratel (full)");
    expect(descriptor.skipForModel).toBeUndefined();
  });
});

describe("buildRatelFullBundle", () => {
  // The arm's contract (per ADR-0006 mode (c)) is dual-layer: BM25 top-K of
  // the prompt is registered as direct tools so the model sees its likely
  // best moves up front, AND the search/invoke gateway is exposed so the
  // model can recover when pre-discovery missed. Each assertion below pins
  // one half of that contract.
  it("registers both gateway tools (search_tools + invoke_tool) — fallback path", () => {
    const { bundle } = buildRatelFullBundle({
      scenario: { prompt: "read a file from disk" },
      pool,
      topK: 2,
    });
    expect(bundle.tools.search_tools).toBeDefined();
    expect(bundle.tools.invoke_tool).toBeDefined();
  });

  it("registers BM25 top-K of the user prompt as direct tools — pre-discovery path", () => {
    const { bundle } = buildRatelFullBundle({
      scenario: { prompt: "read a file from disk" },
      pool,
      topK: 2,
    });
    // The prompt matches fs.read_file via BM25; that hit must show up in
    // activeToolIds, proving pre-discovery actually ran and isn't a no-op.
    // activeToolIds also includes the two gateway tools (search_tools,
    // invoke_tool) — direct tools are bounded above by topK (2 here).
    expect(bundle.activeToolIds).toContain("fs.read_file");
    expect(bundle.activeToolIds).toContain("search_tools");
    expect(bundle.activeToolIds).toContain("invoke_tool");
    const directIds = bundle.activeToolIds.filter(
      (id) => id !== "search_tools" && id !== "invoke_tool",
    );
    expect(directIds.length).toBeGreaterThan(0);
    expect(directIds.length).toBeLessThanOrEqual(2);
  });

  it("backs the gateway with the full pool, not just top-K", () => {
    // Pre-discovery and gateway must coexist: top-K becomes direct tools,
    // but the gateway can still surface every other tool in the pool when
    // pre-discovery missed. The catalog therefore holds the *full* pool.
    const { catalog } = buildRatelFullBundle({
      scenario: { prompt: "read a file from disk" },
      pool,
      topK: 1,
    });
    expect(catalog.has("fs.read_file")).toBe(true);
    expect(catalog.has("fs.write_file")).toBe(true);
    expect(catalog.has("mail.send")).toBe(true);
  });

  it("normalizes empty input schemas at the AI SDK boundary", () => {
    // MetaTool tools ship with `input_schema: {}` — Anthropic's API rejects
    // tools whose input_schema is missing `type: "object"`. The ratel arm,
    // like control, has to normalize at the provider seam.
    const noSchema: ToolSpec = {
      id: "FinanceTool",
      name: "FinanceTool",
      description: "Finance plugin.",
      input_schema: {},
    };
    const { bundle } = buildRatelFullBundle({
      scenario: { prompt: "FinanceTool" },
      pool: [noSchema],
      topK: 1,
    });
    const t = bundle.tools.FinanceTool as unknown as {
      inputSchema: { jsonSchema: { type?: string } };
    };
    expect(t.inputSchema.jsonSchema.type).toBe("object");
  });
});
