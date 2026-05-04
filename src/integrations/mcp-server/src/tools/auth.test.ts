import type { UpstreamServerInfo } from "@ratel-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AuthFlowResult } from "../oauth/flow.js";
import { AUTH_TOOL_ID, authTool } from "./auth.js";

describe("authTool", () => {
  it("uses the canonical id", () => {
    const tool = authTool([], async () => []);
    expect(tool.id).toBe(AUTH_TOOL_ID);
    expect(tool.name).toBe(AUTH_TOOL_ID);
    expect(AUTH_TOOL_ID).toBe("auth");
  });

  it("description includes the always-on guidance pointer", () => {
    const tool = authTool([], async () => []);
    expect(tool.description).toMatch(/Re-authorize an upstream MCP server/);
    expect(tool.description).toMatch(/needs_auth/);
  });

  it("description appends 'Currently needs auth: <names>' when any upstream is flagged", () => {
    const upstreams: UpstreamServerInfo[] = [
      { name: "stripe", needsAuth: true },
      { name: "fs", toolCount: 1 },
      { name: "linear", needsAuth: true },
    ];
    const tool = authTool(upstreams, async () => []);
    expect(tool.description).toMatch(/Currently needs auth: stripe, linear/);
  });

  it("omits 'Currently needs auth' when no upstream is flagged", () => {
    const upstreams: UpstreamServerInfo[] = [
      { name: "fs", toolCount: 1 },
      { name: "remote", toolCount: 2 },
    ];
    const tool = authTool(upstreams, async () => []);
    expect(tool.description).not.toMatch(/Currently needs auth/);
  });

  it("description re-evaluates from the live upstreams reference (so list_changed surfaces fresh state)", () => {
    const upstreams: UpstreamServerInfo[] = [{ name: "stripe", needsAuth: true }];
    const tool = authTool(upstreams, async () => []);
    expect(tool.description).toMatch(/Currently needs auth: stripe/);

    upstreams[0].needsAuth = false;
    expect(tool.description).not.toMatch(/Currently needs auth/);
  });

  it("input schema declares optional `name`", () => {
    const tool = authTool([], async () => []);
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.name).toBeDefined();
    expect(schema.required ?? []).not.toContain("name");
  });

  it("execute calls runAuthFlow with no opts when name is absent", async () => {
    const runAuthFlow = vi.fn(async (): Promise<AuthFlowResult[]> => []);
    const tool = authTool([], runAuthFlow);
    await tool.execute({});
    expect(runAuthFlow).toHaveBeenCalledWith({});
  });

  it("execute forwards the name option when provided", async () => {
    const runAuthFlow = vi.fn(async (): Promise<AuthFlowResult[]> => []);
    const tool = authTool([], runAuthFlow);
    await tool.execute({ name: "stripe" });
    expect(runAuthFlow).toHaveBeenCalledWith({ name: "stripe" });
  });

  it("execute returns the orchestrator's results under a `results` key", async () => {
    const results: AuthFlowResult[] = [
      { name: "stripe", status: "authorized" },
      { name: "linear", status: "failed", reason: "user denied" },
    ];
    const tool = authTool([], async () => results);
    const out = (await tool.execute({})) as { results: AuthFlowResult[] };
    expect(out.results).toEqual(results);
  });

  it("execute catches orchestrator throws and reports them as a single failed row", async () => {
    const tool = authTool([], async () => {
      throw new Error("boom");
    });
    const out = (await tool.execute({})) as { results: AuthFlowResult[] };
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/boom/),
    });
  });
});
