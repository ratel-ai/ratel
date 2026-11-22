import { describe, expect, it, vi } from "vitest";
import { finishRun } from "./run-finish.js";
import type { RunResult } from "./runs.js";

// The end of a run in the worker (RC-1234): the run's spans are flushed before
// run.end leaves, because the controller stops a run-state instance as soon as
// it stores run.end. The flush is bounded, and run.end carries the usage the
// worker measured, so tokens never depend on the export.

const OK: RunResult = { status: "ok", output: "hi", traceId: "a".repeat(32) };
const USAGE = {
  inputTokens: 10,
  outputTokens: 2,
  calls: [{ model: "m", inputTokens: 10, outputTokens: 2 }],
};

describe("finishRun", () => {
  it("sends run.end only after a slow export has flushed, with the measured usage", async () => {
    const order: string[] = [];
    const send = vi.fn((result: RunResult) =>
      order.push(`run.end ${JSON.stringify(result.usage)}`),
    );
    await finishRun(OK, {
      flush: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push("flushed");
            resolve();
          }, 30),
        ),
      usage: (traceId) => (traceId === OK.traceId ? USAGE : undefined),
      send,
      warn: () => {},
    });
    expect(order).toEqual(["flushed", `run.end ${JSON.stringify(USAGE)}`]);
  });

  it("gives up on an export that never ends after the timeout, and still sends run.end", async () => {
    const warn = vi.fn();
    const send = vi.fn();
    const started = Date.now();
    await finishRun(OK, { flush: () => new Promise<void>(() => {}), send, warn, timeoutMs: 40 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(send).toHaveBeenCalledWith(OK);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not finish in 40 ms/));
  });

  it("keeps usage the run reported itself, and sends run.end when the flush fails", async () => {
    const own: RunResult = { ...OK, usage: { inputTokens: 1, outputTokens: 1 } };
    const send = vi.fn();
    const warn = vi.fn();
    await finishRun(own, {
      flush: () => Promise.reject(new Error("export down")),
      usage: () => USAGE,
      send,
      warn,
    });
    expect(send).toHaveBeenCalledWith(own);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/export down/));
  });

  it("sends run.end at once without an exporter", async () => {
    const send = vi.fn();
    await finishRun(
      { status: "error", error: { code: "x", message: "y" } },
      { send, warn: () => {} },
    );
    expect(send).toHaveBeenCalledWith({ status: "error", error: { code: "x", message: "y" } });
  });
});
