import { describe, expect, it } from "vitest";
import type { Manifest } from "../manifest.js";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffDelay } from "./backoff.js";
import { Connection, type ConnectionEffect } from "./connection.js";
import type { Envelope } from "./protocol.js";

const MANIFEST: Manifest = {
  sdk: { language: "typescript", name: "@ratel-ai/twin", version: "0.1.0" },
  providers: [],
  twins: [],
};
const LIMITS = {
  maxFrameBytes: 65536,
  ackTimeoutMs: 10_000,
  leaseIntervalMs: 15_000,
  leaseTimeoutMs: 60_000,
  confirmTimeoutMs: 600_000,
};

function machine(random = () => 0) {
  let n = 0;
  return new Connection({
    runner: { instanceId: "rnr_test" },
    manifest: MANIFEST,
    stamp: { nextId: () => `msg_${++n}`, now: () => new Date("2026-11-20T10:00:00Z") },
    random,
  });
}

function registered(): Envelope {
  return {
    v: 1,
    type: "registered",
    id: "c1",
    ts: "2026-11-20T10:00:00Z",
    payload: { connectionId: "conn_1", limits: LIMITS },
  };
}

/** Drives a fresh machine to ready on socket 1. */
function ready(conn = machine()) {
  conn.step({ type: "start" });
  conn.step({ type: "token.ok", gatewayUrl: "wss://gw", token: "tok_1" });
  conn.step({ type: "socket.open", socket: 1 });
  conn.step({ type: "socket.frame", socket: 1, frame: registered() });
  return conn;
}

function sent(effects: ConnectionEffect[]): Envelope[] {
  return effects.flatMap((e) => (e.type === "send" ? [e.frame] : []));
}

describe("backoffDelay", () => {
  it("stays within 1 s and 60 s for any attempt and jitter", () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      for (const r of [0, 0.5, 0.999]) {
        const delay = backoffDelay(attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
        expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
  });

  it("grows with the attempt and caps at 60 s", () => {
    expect(backoffDelay(0, () => 1)).toBe(1_000);
    expect(backoffDelay(3, () => 1)).toBe(8_000);
    expect(backoffDelay(20, () => 1)).toBe(60_000);
  });
});

describe("Connection", () => {
  it("exchanges a token, opens the socket, sends register and waits for registered", () => {
    const conn = machine();
    expect(conn.step({ type: "start" })).toEqual([{ type: "exchange-token" }]);
    expect(conn.step({ type: "token.ok", gatewayUrl: "wss://gw", token: "tok_1" })).toEqual([
      { type: "open-socket", socket: 1, gatewayUrl: "wss://gw", token: "tok_1" },
    ]);
    const [register] = sent(conn.step({ type: "socket.open", socket: 1 }));
    expect(register).toMatchObject({
      v: 1,
      type: "register",
      payload: { runner: { instanceId: "rnr_test" }, manifest: MANIFEST, maxConcurrency: 1 },
    });
    expect(conn.phase.kind).toBe("registering");
    expect(conn.step({ type: "socket.frame", socket: 1, frame: registered() })).toEqual([
      {
        type: "registered",
        connectionId: "conn_1",
        limits: LIMITS,
        reconnected: false,
        drained: false,
      },
    ]);
    expect(conn.phase).toMatchObject({ kind: "ready", connectionId: "conn_1" });
  });

  it("reconnects after a closed socket with backoff and a fresh token", () => {
    const conn = ready();
    const effects = conn.step({ type: "socket.closed", socket: 1, reason: "1006" });
    expect(effects).toEqual([
      { type: "disconnected", reason: "1006", retryInMs: 1_000 },
      { type: "schedule-retry", delayMs: 1_000 },
    ]);
    expect(conn.step({ type: "retry.due" })).toEqual([{ type: "exchange-token" }]);
    expect(conn.step({ type: "token.ok", gatewayUrl: "wss://gw", token: "tok_2" })).toEqual([
      { type: "open-socket", socket: 2, gatewayUrl: "wss://gw", token: "tok_2" },
    ]);
    conn.step({ type: "socket.open", socket: 2 });
    expect(conn.step({ type: "socket.frame", socket: 2, frame: registered() })).toEqual([
      expect.objectContaining({ type: "registered", reconnected: true }),
    ]);
  });

  it("backs off further on each failed attempt until one registers", () => {
    const conn = machine(() => 1);
    conn.step({ type: "start" });
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const effects = conn.step({ type: "token.failed", message: "503", fatal: false });
      const retry = effects.find((e) => e.type === "schedule-retry");
      delays.push((retry as { delayMs: number }).delayMs);
      conn.step({ type: "retry.due" });
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("stops on a fatal token error", () => {
    const conn = machine();
    conn.step({ type: "start" });
    expect(conn.step({ type: "token.failed", message: "401", fatal: true })).toEqual([
      { type: "fatal", message: "401" },
    ]);
    expect(conn.step({ type: "retry.due" })).toEqual([]);
  });

  it("sends manifest.update on the live socket when ready", () => {
    const conn = ready();
    const next = { ...MANIFEST, twins: [] as Manifest["twins"], build: { id: "abc" } };
    const effects = conn.step({ type: "manifest.changed", manifest: next });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "send", socket: 1 });
    expect(sent(effects)[0]).toMatchObject({
      type: "manifest.update",
      payload: { manifest: next },
    });
  });

  it("puts a manifest that changed while disconnected into the next register", () => {
    const conn = ready();
    conn.step({ type: "socket.closed", socket: 1, reason: "1006" });
    const next = { ...MANIFEST, build: { id: "abc" } };
    expect(conn.step({ type: "manifest.changed", manifest: next })).toEqual([]);
    conn.step({ type: "retry.due" });
    conn.step({ type: "token.ok", gatewayUrl: "wss://gw", token: "tok_2" });
    const [register] = sent(conn.step({ type: "socket.open", socket: 2 }));
    expect(register?.payload).toMatchObject({ manifest: next });
  });

  it("ignores events of a stale socket", () => {
    const conn = ready();
    conn.step({ type: "socket.closed", socket: 1, reason: "1006" });
    conn.step({ type: "retry.due" });
    conn.step({ type: "token.ok", gatewayUrl: "wss://gw", token: "tok_2" });
    expect(conn.step({ type: "socket.closed", socket: 1, reason: "late" })).toEqual([]);
    expect(conn.step({ type: "socket.frame", socket: 1, frame: registered() })).toEqual([]);
    expect(conn.phase).toMatchObject({ kind: "opening", socket: 2 });
  });

  it("passes other frames to the run layer once ready", () => {
    const conn = ready();
    const cancel: Envelope = { ...registered(), type: "run.cancel", runId: "run_1", payload: {} };
    expect(conn.step({ type: "socket.frame", socket: 1, frame: cancel })).toEqual([
      { type: "frame", frame: cancel },
    ]);
  });

  it("closes the socket on stop", () => {
    const conn = ready();
    expect(conn.step({ type: "stop" })).toEqual([{ type: "close-socket", socket: 1 }]);
    expect(conn.phase.kind).toBe("stopped");
  });

  it("drains make-before-break: registers on a new socket, then closes the old one", () => {
    const conn = ready();
    const drain: Envelope = { ...registered(), type: "drain", payload: { deadlineMs: 30_000 } };
    expect(conn.step({ type: "socket.frame", socket: 1, frame: drain })).toEqual([
      { type: "exchange-token" },
    ]);
    expect(conn.step({ type: "token.ok", gatewayUrl: "wss://gw2", token: "tok_2" })).toEqual([
      { type: "open-socket", socket: 2, gatewayUrl: "wss://gw2", token: "tok_2" },
    ]);
    // The old socket keeps serving the run layer during the switch.
    const cancel: Envelope = { ...registered(), type: "run.cancel", runId: "r", payload: {} };
    expect(conn.step({ type: "socket.frame", socket: 1, frame: cancel })).toEqual([
      { type: "frame", frame: cancel },
    ]);
    const [register] = sent(conn.step({ type: "socket.open", socket: 2 }));
    expect(register?.type).toBe("register");
    const next = { ...registered(), payload: { connectionId: "conn_2", limits: LIMITS } };
    expect(conn.step({ type: "socket.frame", socket: 2, frame: next })).toEqual([
      { type: "close-socket", socket: 1 },
      {
        type: "registered",
        connectionId: "conn_2",
        limits: LIMITS,
        reconnected: true,
        drained: true,
      },
    ]);
    expect(conn.phase).toEqual({
      kind: "ready",
      socket: 2,
      connectionId: "conn_2",
      limits: LIMITS,
    });
  });

  it("lets the replacement carry on when the old socket closes first during a drain", () => {
    const conn = ready();
    const drain: Envelope = { ...registered(), type: "drain", payload: {} };
    conn.step({ type: "socket.frame", socket: 1, frame: drain });
    conn.step({ type: "token.ok", gatewayUrl: "wss://gw2", token: "tok_2" });
    expect(conn.step({ type: "socket.closed", socket: 1, reason: "1001" })).toEqual([]);
    expect(conn.phase).toMatchObject({ kind: "opening", socket: 2 });
    conn.step({ type: "socket.open", socket: 2 });
    expect(conn.step({ type: "socket.frame", socket: 2, frame: registered() })).toEqual([
      expect.objectContaining({ type: "registered", reconnected: true, drained: false }),
    ]);
  });

  it("keeps the old socket when the replacement fails during a drain", () => {
    const conn = ready();
    const drain: Envelope = { ...registered(), type: "drain", payload: {} };
    conn.step({ type: "socket.frame", socket: 1, frame: drain });
    conn.step({ type: "token.ok", gatewayUrl: "wss://gw2", token: "tok_2" });
    expect(conn.step({ type: "socket.closed", socket: 2, reason: "refused" })).toEqual([]);
    expect(conn.phase).toEqual({
      kind: "ready",
      socket: 1,
      connectionId: "conn_1",
      limits: LIMITS,
    });
  });
});
