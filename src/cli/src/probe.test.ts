import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AuthStep, ServerEntry } from "@ratel-ai/mcp-server";
import type { McpServerHandle } from "@ratel-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { authProbeEntry, probeEntryInstructions } from "./probe.js";

async function makeUpstream(opts: { instructions?: string }): Promise<Transport> {
  const server = new Server(
    { name: "fake", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

const ENTRY: ServerEntry = { type: "stdio", command: "noop" };

describe("probeEntryInstructions", () => {
  it("returns the upstream's instructions when present", async () => {
    const transport = await makeUpstream({ instructions: "use this server for X" });
    const got = await probeEntryInstructions("up", ENTRY, {
      transportFactory: () => transport,
      timeoutMs: 1000,
    });
    expect(got).toBe("use this server for X");
  });

  it("returns undefined when the upstream provides no instructions", async () => {
    const transport = await makeUpstream({});
    const got = await probeEntryInstructions("up", ENTRY, {
      transportFactory: () => transport,
      timeoutMs: 1000,
    });
    expect(got).toBeUndefined();
  });

  it("returns undefined when the transport factory yields no transport", async () => {
    const got = await probeEntryInstructions("up", ENTRY, {
      transportFactory: () => undefined,
      timeoutMs: 1000,
    });
    expect(got).toBeUndefined();
  });

  it("returns undefined on connect timeout (does not throw)", async () => {
    // A transport that never responds: we hand back an InMemoryTransport pair but
    // don't connect a server, so the client's handshake will hang.
    const [transport] = InMemoryTransport.createLinkedPair();
    const got = await probeEntryInstructions("up", ENTRY, {
      transportFactory: () => transport,
      timeoutMs: 50,
    });
    expect(got).toBeUndefined();
  });

  it("returns undefined when the transport factory throws (does not propagate)", async () => {
    const got = await probeEntryInstructions("up", ENTRY, {
      transportFactory: () => {
        throw new Error("nope");
      },
      timeoutMs: 50,
    });
    expect(got).toBeUndefined();
  });
});

const HTTP_ENTRY: ServerEntry = { type: "http", url: "https://example/mcp" };

function fakeHandle(opts: { instructions?: string } = {}): McpServerHandle {
  return {
    toolIds: [],
    serverInstructions: opts.instructions,
    close: vi.fn(async () => {}),
  };
}

describe("authProbeEntry", () => {
  it("returns authorized + instructions when the AuthStep succeeds", async () => {
    const handle = fakeHandle({ instructions: "stripe upstream instructions" });
    const step: AuthStep = async () => ({
      status: "authorized",
      handle,
      description: "stripe upstream instructions",
      instructions: "stripe upstream instructions",
    });

    const result = await authProbeEntry("stripe", HTTP_ENTRY, { authStep: step });

    expect(result.status).toBe("authorized");
    expect(result.instructions).toBe("stripe upstream instructions");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("returns failed status with reason when the AuthStep fails (does not throw)", async () => {
    const step: AuthStep = async () => ({ status: "failed", reason: "user denied" });
    const result = await authProbeEntry("stripe", HTTP_ENTRY, { authStep: step });
    expect(result).toEqual({ status: "failed", reason: "user denied" });
  });

  it("returns skipped status with reason when the AuthStep skips", async () => {
    const step: AuthStep = async () => ({
      status: "skipped",
      reason: "stdio entries do not use OAuth",
    });
    const result = await authProbeEntry("stripe", HTTP_ENTRY, { authStep: step });
    expect(result).toEqual({ status: "skipped", reason: "stdio entries do not use OAuth" });
  });

  it("catches a thrown AuthStep and returns a failed result with the message", async () => {
    const step: AuthStep = async () => {
      throw new Error("boom");
    };
    const result = await authProbeEntry("stripe", HTTP_ENTRY, { authStep: step });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/boom/);
  });

  it("passes a fresh ToolCatalog to the AuthStep so registered tools don't leak", async () => {
    const seenCatalogs: unknown[] = [];
    const step: AuthStep = async (_n, _e, ctx) => {
      seenCatalogs.push(ctx.catalog);
      return { status: "authorized", handle: fakeHandle() };
    };
    await authProbeEntry("a", HTTP_ENTRY, { authStep: step });
    await authProbeEntry("b", HTTP_ENTRY, { authStep: step });
    expect(seenCatalogs[0]).not.toBe(seenCatalogs[1]);
  });
});
