import { describe, expect, it } from "vitest";
import type { Manifest } from "../manifest.js";
import { fixture } from "../test-support/controller.js";
import { TRUNCATION_MARKER } from "./frame-size.js";
import { MAX_FRAME_BYTES } from "./protocol.js";
import { Runs, type RunsEffect } from "./runs.js";

const MANIFEST = (fixture("register.json").payload as { manifest: Manifest }).manifest;
const START = fixture("run.start.json");
const RUN_ID = START.runId as string;
const T0 = new Date("2026-11-20T10:00:00Z");

function runs(maxConcurrency = 1) {
  let n = 0;
  return new Runs({ stamp: { nextId: () => `w_${++n}`, now: () => T0 }, maxConcurrency });
}

function frames(effects: RunsEffect[]) {
  return effects.flatMap((e) => (e.type === "send" ? [e.frame] : []));
}

function started(r = runs()) {
  r.start(START, MANIFEST, T0);
  return r;
}

describe("Runs.start", () => {
  it("acks a valid run.start and executes it once", () => {
    const effects = runs().start(START, MANIFEST, T0);
    expect(effects.map((e) => e.type)).toEqual(["send", "execute"]);
    expect(frames(effects)[0]).toMatchObject({ type: "run.ack", runId: RUN_ID, payload: {} });
    expect(effects[1]).toMatchObject({ type: "execute", runId: RUN_ID, start: START.payload });
  });

  it("re-acks a duplicate run.start without running it again, also after it ended", () => {
    const r = started();
    const again = r.start(START, MANIFEST, T0);
    expect(again.map((e) => e.type)).toEqual(["send"]);
    expect(frames(again)[0]?.type).toBe("run.ack");
    r.end(RUN_ID, { status: "ok", output: {} });
    r.ack(RUN_ID, 1);
    expect(r.start(START, MANIFEST, T0).map((e) => e.type)).toEqual(["send"]);
  });

  it("rejects an unknown sandbox", () => {
    const start = { ...START, payload: { ...START.payload, sandboxId: "nope" } };
    const [reject] = frames(runs().start(start, MANIFEST, T0));
    expect(reject).toMatchObject({ type: "run.reject", payload: { reason: "unknown_sandbox" } });
  });

  it("rejects params outside the manifest with one error per param", () => {
    const payload = START.payload as { params: Record<string, unknown> };
    const start = {
      ...START,
      payload: { ...payload, params: { ...payload.params, maxTokens: 9999, extra: 1 } },
    };
    const [reject] = frames(runs().start(start, MANIFEST, T0));
    expect(reject).toMatchObject({
      type: "run.reject",
      payload: {
        reason: "invalid_params",
        errors: [
          { param: "maxTokens", message: "must be at most 2000" },
          { param: "extra", message: "is an unknown param" },
        ],
      },
    });
  });

  it("rejects busy at the concurrency limit", () => {
    const r = started();
    const [reject] = frames(r.start({ ...START, runId: "run_2" }, MANIFEST, T0));
    expect(reject).toMatchObject({
      type: "run.reject",
      runId: "run_2",
      payload: { reason: "busy" },
    });
  });
});

describe("Runs events", () => {
  it("numbers events and the end by seq from 1", () => {
    const r = started();
    const sent = [
      ...frames(r.event(RUN_ID, { kind: "log", level: "info", message: "a" })),
      ...frames(r.event(RUN_ID, { kind: "log", level: "info", message: "b" })),
      ...frames(r.end(RUN_ID, { status: "ok", output: { name: "x" }, traceId: "a".repeat(32) })),
    ];
    expect(sent.map((f) => [f.type, f.seq])).toEqual([
      ["run.event", 1],
      ["run.event", 2],
      ["run.end", 3],
    ]);
    expect(sent[2]?.payload).toMatchObject({ status: "ok", output: { name: "x" } });
  });

  it("keeps unacked frames for a resend and drops them on events.ack", () => {
    const r = started();
    for (const m of ["a", "b", "c"]) r.event(RUN_ID, { kind: "log", level: "info", message: m });
    r.ack(RUN_ID, 2);
    expect(r.unacked().map((f) => f.seq)).toEqual([3]);
    r.end(RUN_ID, { status: "ok" });
    expect(r.unacked().map((f) => f.seq)).toEqual([3, 4]);
    r.ack(RUN_ID, 4);
    expect(r.unacked()).toEqual([]);
    expect(r.active).toBe(0);
  });

  it("ignores a stale or repeated events.ack", () => {
    const r = started();
    for (const m of ["a", "b"]) r.event(RUN_ID, { kind: "log", level: "info", message: m });
    r.ack(RUN_ID, 2);
    r.ack(RUN_ID, 1);
    expect(r.unacked()).toEqual([]);
    expect(frames(r.event(RUN_ID, { kind: "log", level: "info", message: "c" }))[0]?.seq).toBe(3);
  });
});

describe("Runs cancel and lease", () => {
  it("turns run.cancel into an abort of a live run only", () => {
    const r = started();
    expect(r.cancel(RUN_ID)).toEqual([
      { type: "abort", runId: RUN_ID, reason: "canceled by the controller" },
    ]);
    r.end(RUN_ID, { status: "canceled" });
    expect(r.cancel(RUN_ID)).toEqual([]);
  });

  it("leases each live run with its elapsed time", () => {
    const r = started();
    const [lease] = frames(r.lease(new Date(T0.getTime() + 15_000)));
    expect(lease).toMatchObject({
      type: "run.lease",
      runId: RUN_ID,
      payload: { elapsedMs: 15_000 },
    });
    r.end(RUN_ID, { status: "ok" });
    expect(r.lease(new Date(T0.getTime() + 30_000))).toEqual([]);
  });
});

describe("Runs frame size", () => {
  const bytes = (f: object) => Buffer.byteLength(JSON.stringify(f));

  it("splits a long text.delta into frames of at most 64 KB, in order", () => {
    const r = started();
    const text = "é".repeat(100_000);
    const sent = frames(r.event(RUN_ID, { kind: "text.delta", text }));
    expect(sent.length).toBeGreaterThan(1);
    for (const f of sent) expect(bytes(f)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(sent.map((f) => (f.payload as { text: string }).text).join("")).toBe(text);
    expect(sent.map((f) => f.seq)).toEqual(sent.map((_, i) => i + 1));
  });

  it("cuts a long log message and a large output with a marker", () => {
    const r = started();
    const [log] = frames(
      r.event(RUN_ID, { kind: "log", level: "info", message: "x".repeat(200_000) }),
    );
    expect(bytes(log as object)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect((log?.payload as { message: string }).message.endsWith(TRUNCATION_MARKER)).toBe(true);
    const [end] = frames(r.end(RUN_ID, { status: "ok", output: { rows: "y".repeat(300_000) } }));
    expect(bytes(end as object)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(end?.payload).toMatchObject({ status: "ok", output: { truncated: true } });
  });
});
