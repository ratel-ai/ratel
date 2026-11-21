import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type OtlpKeyValue,
  type ReceivedFrame,
  startTestController,
  type TestController,
} from "../test-support/controller.js";
import { type Dev, INDEX, PROJECT_KEY, startRatelDev } from "../test-support/ratel-dev.js";
import { MAX_FRAME_BYTES } from "./protocol.js";

// Runs over the socket, end to end: the real `ratel dev` executes a twin that
// run.start asks for, against the in-process test controller.

const LEASE_MS = 300;
const SDK_TRACE_NODE = import.meta.resolve("@opentelemetry/sdk-trace-node");

/** A twin driven by its input: steps with a delay, a hang until canceled, a large output. */
const TWIN = `import { writeFileSync } from "node:fs";
import { NodeTracerProvider } from ${JSON.stringify(SDK_TRACE_NODE)};
import { twin } from ${JSON.stringify(INDEX)};

// The project's own tracer provider: the runner must use it, never a second one.
new NodeTracerProvider().register();

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

export default twin("workflow-label", {
  params: {
    model: twin.model("anthropic/claude-sonnet-5-5"),
    system: twin.prompt("You name agent workflows."),
    maxTokens: twin.int(400, { min: 50, max: 2000 }),
  },
  input: twin.structured({ type: "object" }),
  redact: (p) => (p.kind === "log" ? { ...p, message: String(p.message).replace(/sk-[\\w-]+/g, "[redacted]") } : p),
  run: async ({ input, params, ctx }) => {
    ctx.signal.addEventListener("abort", () => writeFileSync("aborted.txt", String(ctx.signal.reason)));
    for (let i = 1; i <= (input.steps ?? 0); i++) {
      ctx.log(i === 1 ? "step 1 with key sk-live-123" : \`step \${i}\`);
      await sleep(input.delayMs ?? 0, ctx.signal);
    }
    if (input.bigLog) ctx.log("L".repeat(input.bigLog));
    if (input.hang) { ctx.log("waiting"); await sleep(600_000, ctx.signal); }
    return { model: params.model, maxTokens: params.maxTokens, big: "B".repeat(input.big ?? 0) };
  },
});
`;

describe("runs over the socket", () => {
  let project: string;
  let controller: TestController;
  let dev: Dev;
  let runCount = 0;
  const nextRunId = () => `run_e2e_${++runCount}`;

  const ofRun = (runId: string, type?: string) =>
    controller.frames.filter((f) => f.frame.runId === runId && (!type || f.frame.type === type));
  const waitFor = (runId: string, type: string, timeoutMs?: number) =>
    controller.waitForFrame((f) => f.frame.runId === runId && f.frame.type === type, timeoutMs);
  const expectStoredInOrder = (runId: string) => {
    const stored = controller.stored(runId);
    expect(stored.map((f) => f.seq)).toEqual(stored.map((_, i) => i + 1));
    expect(stored.at(-1)?.type).toBe("run.end");
    return stored;
  };

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "ratel-dev-runs-"));
    writeFileSync(join(project, "label.twin.mjs"), TWIN);
    controller = await startTestController({ limits: { leaseIntervalMs: LEASE_MS } });
    dev = startRatelDev(project, controller.url);
    await dev.waitForOutput("connected (conn_1)");
  });

  afterAll(async () => {
    dev.child.kill("SIGKILL");
    await controller.close();
    rmSync(project, { recursive: true, force: true });
  });

  it("acks within 10 s, leases, streams events by seq and ends with the output and trace ID", async () => {
    const runId = nextRunId();
    const sentAt = Date.now();
    controller.startRun(runId, { input: { steps: 3, delayMs: 400 } });
    await waitFor(runId, "run.ack");
    expect(Date.now() - sentAt).toBeLessThan(10_000);
    const end = await waitFor(runId, "run.end");
    const stored = expectStoredInOrder(runId);
    expect(stored.map((f) => f.type)).toEqual(["run.event", "run.event", "run.event", "run.end"]);
    expect(stored[0]?.payload).toEqual({
      kind: "log",
      level: "info",
      message: "step 1 with key [redacted]",
    });
    expect(end.frame.payload).toMatchObject({
      status: "ok",
      // The fixture's run.start asks for these values: run() gets the bare model ID.
      output: { model: "claude-haiku-5-5", maxTokens: 100, big: "" },
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      overrides: ["model", "maxTokens"],
    });
    expect(ofRun(runId, "run.lease").length).toBeGreaterThanOrEqual(2);
    expect(dev.stdout()).not.toContain("sk-live-123");
  });

  it("exports the run's trace to /api/v1/traces with the playground attributes", async () => {
    const runId = nextRunId();
    controller.startRun(runId, { input: { steps: 1 }, sessionId: "pgs_e2e" });
    const end = await waitFor(runId, "run.end");
    const traceId = (end.frame.payload as { traceId: string }).traceId;
    await expect.poll(() => exportedRoot(controller, traceId), { timeout: 10_000 }).toBeDefined();
    const found = exportedRoot(controller, traceId);
    expect(found?.key).toBe(PROJECT_KEY);
    expect(found?.resource).toMatchObject({
      "deployment.environment.name": "playground",
      "ratel.runner.instance_id": expect.stringMatching(/^rnr_/),
      "ratel.runner.sdk.name": "@ratel-ai/twin",
    });
    expect(found?.span).toMatchObject({
      name: "invoke_workflow workflow-label",
      attributes: {
        "gen_ai.conversation.id": "pgs_e2e",
        "ratel.twin.id": "workflow-label",
        "ratel.twin.run_id": runId,
        "ratel.twin.overrides": ["model", "maxTokens"],
        "ratel.twin.config_hash": expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("re-acks a duplicate run.start and runs the twin once", async () => {
    const runId = nextRunId();
    controller.startRun(runId, { input: { steps: 1, delayMs: 300 } });
    controller.startRun(runId, { input: { steps: 1, delayMs: 300 } });
    await waitFor(runId, "run.end");
    controller.startRun(runId, { input: { steps: 1 } });
    await controller.waitForFrame(
      (f) => f.frame.runId === runId && ofRun(runId, "run.ack").length === 3,
    );
    expect(ofRun(runId, "run.ack")).toHaveLength(3);
    expect(ofRun(runId, "run.end")).toHaveLength(1);
    expect(dev.stdout().split(`run ${runId}: workflow-label started`)).toHaveLength(2);
  });

  it("rejects unknown twins, invalid params and a second run while busy", async () => {
    const unknown = controller.startRun(nextRunId(), { twinId: "nope" });
    const invalid = controller.startRun(nextRunId(), { params: { maxTokens: 9999 } });
    const long = controller.startRun(nextRunId(), { input: { steps: 2, delayMs: 300 } });
    const busy = controller.startRun(nextRunId(), {});
    const reason = async (runId: string) =>
      ((await waitFor(runId, "run.reject")).frame.payload as { reason: string }).reason;
    expect(await reason(unknown)).toBe("unknown_twin");
    expect(await reason(invalid)).toBe("invalid_params");
    expect(await reason(busy)).toBe("busy");
    await waitFor(long, "run.end");
  });

  it("resends events sent while the socket was down after the reconnect, once and in order", async () => {
    const runId = nextRunId();
    controller.startRun(runId, { input: { steps: 6, delayMs: 300 } });
    await waitFor(runId, "run.event");
    const before = controller.sockets.length;
    controller.dropAll();
    await waitFor(runId, "run.end", 20_000);
    expect(controller.sockets.length).toBe(before + 1);
    expectStoredInOrder(runId);
    expect(controller.stored(runId)).toHaveLength(7);
    // Only unacked events are resent: at most the one whose ack was in flight at the drop.
    const seqsOn = (connection: number) =>
      new Set(
        ofRun(runId)
          .filter((f) => f.connection === connection && f.frame.seq)
          .map((f) => f.frame.seq),
      );
    const first = seqsOn(before);
    const resent = [...seqsOn(before + 1)].filter((seq) => first.has(seq));
    expect(resent.length).toBeLessThanOrEqual(1);
    expect(controller.invalid).toEqual([]);
  });

  it("aborts ctx.signal on run.cancel and ends the run as canceled", async () => {
    const runId = nextRunId();
    controller.startRun(runId, { input: { hang: true } });
    await waitFor(runId, "run.event");
    controller.send({
      v: 1,
      type: "run.cancel",
      id: "c_cancel",
      ts: new Date().toISOString(),
      runId,
      payload: { reason: "stop" },
    });
    const end = await waitFor(runId, "run.end");
    expect(end.frame.payload).toMatchObject({ status: "canceled" });
    await expect.poll(() => existsSync(join(project, "aborted.txt"))).toBe(true);
    expect(readFileSync(join(project, "aborted.txt"), "utf8")).toContain("stop");
  });

  it("keeps a live run going across a drain: new socket first, then the old one closes", async () => {
    const runId = nextRunId();
    controller.startRun(runId, { input: { steps: 5, delayMs: 300 } });
    await waitFor(runId, "run.event");
    const old = controller.sockets.length;
    controller.send({
      v: 1,
      type: "drain",
      id: "c_drain",
      ts: new Date().toISOString(),
      payload: { reason: "deploy", deadlineMs: 30_000 },
    });
    const register: ReceivedFrame = await controller.waitForFrame(
      (f) => f.frame.type === "register" && f.connection === old + 1,
    );
    expect(register.openSockets).toBe(2);
    const end = await waitFor(runId, "run.end", 20_000);
    expect(end.connection).toBe(old + 1);
    expect(end.frame.payload).toMatchObject({ status: "ok" });
    expectStoredInOrder(runId);
    await dev.waitForOutput(`moved to a new gateway (conn_${old + 1})`);
  });

  it("keeps every frame within 64 KB: long text and large outputs are cut with a marker", async () => {
    const runId = nextRunId();
    controller.startRun(runId, { input: { bigLog: 150_000, big: 300_000 } });
    const end = await waitFor(runId, "run.end");
    expect(end.frame.payload, JSON.stringify(end.frame.payload).slice(0, 500)).toMatchObject({
      status: "ok",
      output: { truncated: true },
    });
    for (const { raw } of controller.frames)
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(controller.invalid).toEqual([]);
  });
});

/** The exported root span of a trace, with its resource and the key it was sent with. */
function exportedRoot(controller: TestController, traceId: string) {
  for (const { key, body } of controller.traces) {
    for (const rs of body.resourceSpans) {
      for (const ss of rs.scopeSpans) {
        const span = ss.spans.find((s) => s.traceId === traceId && s.name.startsWith("invoke_"));
        if (span) {
          return {
            key,
            resource: plain(rs.resource.attributes),
            span: { name: span.name, attributes: plain(span.attributes) },
          };
        }
      }
    }
  }
  return undefined;
}

function plain(attributes: OtlpKeyValue[]): Record<string, unknown> {
  const value = (v: OtlpKeyValue["value"]): unknown =>
    v.arrayValue ? v.arrayValue.values.map(value) : (v.stringValue ?? v.boolValue ?? v.intValue);
  return Object.fromEntries(attributes.map((a) => [a.key, value(a.value)]));
}
