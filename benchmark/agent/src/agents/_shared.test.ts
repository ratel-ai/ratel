import type { ExecutableTool } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../types.js";
import {
  buildToolBundle,
  emptyToolBundle,
  normalizeInputSchema,
  registerGateway,
  sanitizeToolName,
} from "./_shared.js";

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

describe("normalizeInputSchema", () => {
  it("defaults type to object when missing", () => {
    expect(normalizeInputSchema({})).toEqual({ type: "object" });
  });

  it("leaves a valid object schema untouched", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    expect(normalizeInputSchema(schema)).toEqual(schema);
  });

  it("treats null/undefined/non-object as empty", () => {
    expect(normalizeInputSchema(null)).toEqual({ type: "object" });
    expect(normalizeInputSchema(undefined)).toEqual({ type: "object" });
    expect(normalizeInputSchema("nope")).toEqual({ type: "object" });
  });
});

describe("buildToolBundle", () => {
  const specs: ToolSpec[] = [
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
      input_schema: {},
    },
  ];

  it("registers each spec under its sanitized name and tracks canonical ids", () => {
    const bundle = buildToolBundle(specs);
    expect(Object.keys(bundle.tools).sort()).toEqual(["fs_read_file", "mail_send"]);
    expect(bundle.activeToolIds).toEqual(["fs.read_file", "mail.send"]);
    expect(bundle.nameToId.get("fs_read_file")).toBe("fs.read_file");
    expect(bundle.nameToId.get("mail_send")).toBe("mail.send");
  });

  it("throws on collisions after sanitization", () => {
    const collision: ToolSpec[] = [
      { ...specs[0], id: "fs.read_file" },
      { ...specs[0], id: "fs/read_file" },
    ];
    expect(() => buildToolBundle(collision)).toThrow(/collision/);
  });

  it("normalizes empty schemas at the AI SDK boundary", () => {
    const bundle = buildToolBundle([specs[1]]);
    const t = bundle.tools.mail_send as unknown as {
      inputSchema: { jsonSchema: { type?: string } };
    };
    expect(t.inputSchema.jsonSchema.type).toBe("object");
  });
});

describe("registerGateway", () => {
  const stub: ExecutableTool = {
    id: "search_tools",
    name: "search_tools",
    description: "stub",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute: async () => ({}),
  };

  it("registers the gateway tool and counts it toward activeToolIds", () => {
    // The catalog column in the report reads activeToolIds.length, and we
    // want gateway tools (search_tools / invoke_tool) to count there — the
    // agent really did see them, even though they aren't direct tools.
    const bundle = emptyToolBundle();
    registerGateway(stub, bundle);
    expect(Object.keys(bundle.tools)).toEqual(["search_tools"]);
    expect(bundle.activeToolIds).toEqual(["search_tools"]);
    expect(bundle.nameToId.size).toBe(0);
  });

  it("throws on duplicate registration", () => {
    const bundle = emptyToolBundle();
    registerGateway(stub, bundle);
    expect(() => registerGateway(stub, bundle)).toThrow(/already registered/);
  });
});
