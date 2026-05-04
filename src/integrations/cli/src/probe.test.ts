import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerEntry } from "@ratel-ai/mcp-server";
import { describe, expect, it } from "vitest";
import { probeEntryInstructions } from "./probe.js";

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
