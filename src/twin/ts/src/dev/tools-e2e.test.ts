import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestController, type TestController } from "../test-support/controller.js";
import { type Dev, INDEX, startRatelDev } from "../test-support/ratel-dev.js";
import type { Envelope } from "./protocol.js";

// Tool modes over the socket, end to end: the real `ratel dev` runs a chat
// twin whose fake and confirm calls wait for the test controller's answers.

const TWIN = `import { appendFileSync } from "node:fs";
import { twin } from ${JSON.stringify(INDEX)};

const real = (name) => async (args) => { appendFileSync("real-calls.txt", name + "\\n"); return { real: name, args }; };
const tools = {
  searchDocs: { description: "Search the docs.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, execute: real("searchDocs") },
  createTicket: { description: "Open a support ticket.", inputSchema: { type: "object", properties: { title: { type: "string" } } }, execute: real("createTicket") },
  askExpert: { description: "Ask a sub-agent.", inputSchema: { type: "object" }, execute: real("askExpert") },
};

export default twin("support-agent", {
  params: {
    tools: twin.tools(tools, { searchDocs: { readOnly: true }, createTicket: { sideEffect: true }, askExpert: { opaque: true } }),
  },
  input: twin.chat(),
  run: async ({ input, params }) => {
    const messages = input.messages;
    const out = {};
    for (const [name, args] of [["searchDocs", { query: "keys" }], ["createTicket", { title: "Rotate" }], ["askExpert", { q: "?" }]]) {
      out[name] = await params.tools[name].execute(args, { toolCallId: "call_" + name, messages });
    }
    return out;
  },
});
`;

describe("tool modes over the socket", () => {
  let project: string;
  let controller: TestController;
  let dev: Dev;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "ratel-dev-tools-"));
    writeFileSync(join(project, "support.twin.mjs"), TWIN);
    controller = await startTestController();
    dev = startRatelDev(project, controller.url);
    await dev.waitForOutput("connected (conn_1)");
  });

  afterAll(async () => {
    dev.child.kill("SIGKILL");
    await controller.close();
    rmSync(project, { recursive: true, force: true });
  });

  const answer = (runId: string, type: string, payload: Record<string, unknown>): Envelope => ({
    v: 1,
    type,
    id: `c_${type}_${String(payload.callId)}`,
    ts: new Date().toISOString(),
    runId,
    payload,
  });

  it("sends tool.fake.request and tool.confirm.request and continues with the answers", async () => {
    const runId = "run_tools_1";
    controller.startRun(runId, {
      twinId: "support-agent",
      input: { messages: [{ role: "user", content: "How do I rotate a key?" }] },
      params: {},
      toolModes: {},
    });

    const fake = await controller.waitForFrame(
      (f) => f.frame.runId === runId && f.frame.type === "tool.fake.request",
    );
    expect(fake.frame.payload).toMatchObject({
      callId: "call_createTicket",
      tool: "createTicket",
      args: { title: "Rotate" },
      description: "Open a support ticket.",
      messages: [{ role: "user", content: "How do I rotate a key?" }],
    });
    controller.send(
      answer(runId, "tool.fake.result", {
        callId: "call_createTicket",
        result: { id: "T-42" },
        isError: false,
        source: "generated",
      }),
    );

    const confirm = await controller.waitForFrame(
      (f) => f.frame.runId === runId && f.frame.type === "tool.confirm.request",
    );
    expect(confirm.frame.payload).toEqual({
      callId: "call_askExpert",
      tool: "askExpert",
      args: { q: "?" },
    });
    controller.send(
      answer(runId, "tool.confirm.decision", {
        callId: "call_askExpert",
        decision: "edit",
        args: { q: "edited" },
      }),
    );

    const end = await controller.waitForFrame(
      (f) => f.frame.runId === runId && f.frame.type === "run.end",
    );
    expect(end.frame.payload).toMatchObject({
      status: "ok",
      output: {
        searchDocs: { real: "searchDocs", args: { query: "keys" } },
        createTicket: { id: "T-42" },
        askExpert: { real: "askExpert", args: { q: "edited" } },
      },
    });
    // createTicket was faked: its production execute never ran.
    expect(
      readFileSync(join(project, "real-calls.txt"), "utf8").split("\n").filter(Boolean),
    ).toEqual(["searchDocs", "askExpert"]);
    const results = controller
      .stored(runId)
      .filter((f) => (f.payload as { kind?: string }).kind === "tool.result")
      .map((f) => f.payload);
    expect(results).toMatchObject([
      { callId: "call_searchDocs", mode: "real" },
      { callId: "call_createTicket", mode: "fake", fakeSource: "generated" },
      { callId: "call_askExpert", mode: "confirm", confirmDecision: "edit" },
    ]);
    expect(controller.invalid).toEqual([]);
  }, 30_000);

  it("rejects a run.start that asks real for createTicket", async () => {
    const runId = "run_tools_2";
    controller.startRun(runId, {
      twinId: "support-agent",
      input: { messages: [{ role: "user", content: "hi" }] },
      params: {},
      toolModes: { createTicket: "real" },
    });
    const reject = await controller.waitForFrame(
      (f) => f.frame.runId === runId && f.frame.type === "run.reject",
    );
    expect(reject.frame.payload).toMatchObject({
      reason: "invalid_params",
      errors: [
        {
          param: "toolModes",
          message: "createTicket: real needs allowReal: true in the twin file",
        },
      ],
    });
  }, 30_000);
});
