import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Envelope } from "../dev/protocol.js";
import { type ReceivedFrame, startTestController } from "./controller.js";

// Starts the in-process twin/v1 test controller on a fixed port, for a manual
// `ratel dev --url http://127.0.0.1:<port>` session. It prints every frame it
// receives. With --run it starts one run after the first register, and with
// --edit <file> it then appends a comment to that twin file, so the reload and
// its manifest.update show. Test support only: not the Ratel gateway.
//
//   pnpm --filter @ratel-ai/twin controller -- --port 4100 --run --edit agents/label.twin.ts
//
// With --twin <id> --input <chat.json> it starts a run of that twin instead,
// and answers each tool.fake.request with the --fake JSON file (a canned fake
// ticket by default), as the playground would.
//
//   pnpm --filter @ratel-ai/twin controller -- --run --twin docs-agent --input examples/twin-docs-agent/chat.json

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4100" },
    run: { type: "boolean", default: false },
    edit: { type: "string" },
    twin: { type: "string" },
    input: { type: "string" },
    fake: { type: "string" },
  },
});
const FAKE = values.fake
  ? JSON.parse(readFileSync(values.fake, "utf8"))
  : { ticketId: "T-FAKE-1", status: "open" };

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const say = (s: string) => process.stdout.write(`${cyan(`  controller ← ${s}`)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const controller = await startTestController({ port: Number(values.port) });
process.stdout.write(dim(`twin/v1 test controller on ${controller.url}\n`));

let printed = 0;
setInterval(() => {
  for (const received of controller.frames.slice(printed)) say(describe(received));
  printed = controller.frames.length;
}, 50);

if (values.run) {
  await controller.waitForFrame((f) => f.frame.type === "register", 120_000);
  await sleep(1500);
  controller.startRun(
    "run_demo_1",
    values.twin
      ? {
          twinId: values.twin,
          sessionId: "pgs_demo",
          input: JSON.parse(readFileSync(values.input ?? "chat.json", "utf8")),
          params: {},
          toolModes: {},
        }
      : { sessionId: "pgs_demo", input: { workflowId: "wf_12", toolOrder: ["search", "read"] } },
  );
  answerFakes();
  const end = await controller.waitForFrame((f) => f.frame.type === "run.end", 120_000);
  const traceId = (end.frame.payload as { traceId?: string }).traceId;
  for (let i = 0; i < 40 && traceId && !hasTrace(traceId); i++) await sleep(100);
  if (traceId && hasTrace(traceId))
    say(
      `POST /api/v1/traces  ${values.twin ? "invoke_agent" : "invoke_workflow"} ${values.twin ?? "workflow-label"}  trace ${traceId.slice(0, 12)}…`,
    );
  if (values.edit) {
    await sleep(1500);
    process.stdout.write(dim(`\n# edit ${values.edit}\n`));
    appendFileSync(values.edit, "// edited while ratel dev runs\n");
  }
}

/** Answers every tool.fake.request with FAKE, and approves every tool.confirm.request. */
function answerFakes(): void {
  let seen = 0;
  setInterval(() => {
    for (const { frame } of controller.frames.slice(seen)) {
      const p = frame.payload as { callId?: string; tool?: string };
      if (frame.type === "tool.fake.request")
        reply(frame, "tool.fake.result", {
          callId: p.callId,
          result: FAKE,
          isError: false,
          source: "generated",
        });
      if (frame.type === "tool.confirm.request")
        reply(frame, "tool.confirm.decision", { callId: p.callId, decision: "approve" });
    }
    seen = controller.frames.length;
  }, 50);
}

function reply(to: Envelope, type: string, payload: Record<string, unknown>): void {
  const id = `ctl_${type}_${String(payload.callId)}`;
  controller.send({ v: 1, type, id, ts: new Date().toISOString(), runId: to.runId, payload });
  process.stdout.write(
    `${cyan(`  controller → ${type} ${JSON.stringify(payload.result ?? payload.decision)}`)}\n`,
  );
}

function hasTrace(traceId: string): boolean {
  return controller.traces.some(({ body }) =>
    body.resourceSpans.some((rs) =>
      rs.scopeSpans.some((ss) => ss.spans.some((s) => s.traceId === traceId)),
    ),
  );
}

function describe({ frame, connection }: ReceivedFrame): string {
  const p = frame.payload as Record<string, unknown>;
  const run = frame.runId ? ` ${frame.runId}` : "";
  return `${frame.type}${run} ${detail(frame, p)}${dim(` [socket ${connection}]`)}`;
}

function detail(frame: Envelope, p: Record<string, unknown>): string {
  const manifest = p.manifest as
    | { twins?: { id: string }[]; build?: { revision?: string } }
    | undefined;
  switch (frame.type) {
    case "register":
    case "manifest.update":
      return `twins=${manifest?.twins?.map((t) => t.id).join(",")} revision=${manifest?.build?.revision?.slice(0, 8)}…`;
    case "run.event":
      if (p.kind === "text.delta") return `seq=${frame.seq} text.delta ${JSON.stringify(p.text)}`;
      if (p.kind === "tool.call")
        return `seq=${frame.seq} tool.call ${p.tool} mode=${p.mode} args=${JSON.stringify(p.args)}`;
      if (p.kind === "tool.result")
        return `seq=${frame.seq} tool.result ${p.callId} mode=${p.mode}${p.fakeSource ? ` fake=${p.fakeSource}` : ""} ${JSON.stringify(p.result).slice(0, 80)}`;
      return `seq=${frame.seq} ${p.kind} "${p.message}"`;
    case "run.reject":
      return `${p.reason}: ${p.message}`;
    case "tool.fake.request":
      return `${p.tool} args=${JSON.stringify(p.args)}`;
    case "run.end":
      return `seq=${frame.seq} ${p.status} overrides=${JSON.stringify(p.overrides)} output=${JSON.stringify(p.output).slice(0, 80)}`;
    case "run.lease":
      return `elapsed=${p.elapsedMs} ms`;
    default:
      return "";
  }
}
