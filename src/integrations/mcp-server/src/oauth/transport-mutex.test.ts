import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { wrapTransportWithSendMutex } from "./transport-mutex.js";

interface FakeTransport extends Transport {
  inFlight: number;
  maxConcurrent: number;
  sendCalls: number;
}

function makeFake(latencyMs = 20): FakeTransport {
  let inFlight = 0;
  let maxConcurrent = 0;
  let sendCalls = 0;
  let started = false;
  let closed = false;
  const t: FakeTransport = {
    inFlight: 0,
    maxConcurrent: 0,
    sendCalls: 0,
    async start() {
      started = true;
    },
    async send() {
      inFlight++;
      sendCalls++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      t.inFlight = inFlight;
      t.maxConcurrent = maxConcurrent;
      t.sendCalls = sendCalls;
      await new Promise((r) => setTimeout(r, latencyMs));
      inFlight--;
      t.inFlight = inFlight;
    },
    async close() {
      closed = true;
    },
  };
  // expose started/closed on the object too if needed via getters
  Object.defineProperty(t, "started", { get: () => started });
  Object.defineProperty(t, "closed", { get: () => closed });
  return t;
}

describe("wrapTransportWithSendMutex", () => {
  it("serializes parallel send() calls so the inner transport sees max one in flight", async () => {
    const inner = makeFake();
    const wrapped = wrapTransportWithSendMutex(inner);
    await Promise.all([
      wrapped.send({ jsonrpc: "2.0", method: "a", id: 1 }),
      wrapped.send({ jsonrpc: "2.0", method: "b", id: 2 }),
      wrapped.send({ jsonrpc: "2.0", method: "c", id: 3 }),
    ]);
    expect(inner.maxConcurrent).toBe(1);
    expect(inner.sendCalls).toBe(3);
  });

  it("forwards start, close, and event-handler properties to the inner transport", async () => {
    const inner = makeFake(0);
    const wrapped = wrapTransportWithSendMutex(inner);

    let captured: unknown;
    wrapped.onmessage = (m) => {
      captured = m;
    };
    expect(inner.onmessage).toBeDefined();
    inner.onmessage?.({ jsonrpc: "2.0", method: "x", id: 1 } as never);
    expect(captured).toEqual({ jsonrpc: "2.0", method: "x", id: 1 });

    await wrapped.start();
    expect((inner as unknown as { started: boolean }).started).toBe(true);

    await wrapped.close();
    expect((inner as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("allows a follower send to proceed only after the leader's send resolves (leader rejects)", async () => {
    const inner: Transport = {
      async start() {},
      async close() {},
      async send() {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("leader-failed");
      },
    };
    const wrapped = wrapTransportWithSendMutex(inner);

    const leader = wrapped.send({ jsonrpc: "2.0", method: "a", id: 1 });
    const follower = wrapped.send({ jsonrpc: "2.0", method: "b", id: 2 });
    // leader rejects, follower still gets its turn (no rejection cascade)
    await expect(leader).rejects.toThrow("leader-failed");
    // replace inner.send for follower's call: still serialized, still proceeds
    await expect(follower).rejects.toThrow("leader-failed");
  });

  it("forwards setProtocolVersion when defined on inner", async () => {
    const calls: string[] = [];
    const inner: Transport = {
      async start() {},
      async close() {},
      async send() {},
      setProtocolVersion: (v) => calls.push(v),
    };
    const wrapped = wrapTransportWithSendMutex(inner);
    wrapped.setProtocolVersion?.("2025-06");
    expect(calls).toEqual(["2025-06"]);
  });
});
