import { describe, expect, it } from "vitest";
import { withSdkParams } from "./auto-params.js";
import { captureSetup, type SetupCapture } from "./catalog.js";
import { manifestSandbox } from "./manifest.js";
import { model, prompt } from "./params.js";
import { runSandbox } from "./run.js";
import { chat, defineSandbox } from "./sandbox.js";
import { sdkRead, sdkRegisterTools, sdkToolset } from "./test-support/fake-sdk.js";

const searchDocs = {
  description: "Search the docs.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
  execute: async () => ["page"],
};
const createTicket = {
  description: "Open a ticket.",
  inputSchema: { type: "object" },
  annotations: { destructiveHint: true },
  execute: async () => ({ id: 1 }),
};
const askExpert = { description: "Ask an expert.", inputSchema: {}, execute: async () => "ok" };

const capture: SetupCapture = {
  reads: [
    { kind: "model", id: "model", default: "anthropic/claude-haiku-5-5" },
    { kind: "prompt", id: "system", default: "You answer from the docs." },
  ],
  tools: [
    { id: "searchDocs", description: searchDocs.description, tool: searchDocs },
    { id: "createTicket", description: createTicket.description, tool: createTicket },
    { id: "askExpert", description: askExpert.description, tool: askExpert },
  ],
  skills: [],
};

const bare = defineSandbox("auto", { input: chat(), run: async () => "done" });

describe("withSdkParams", () => {
  it("turns catalog reads and registered tools into params with source sdk", () => {
    const s = withSdkParams(bare, capture);
    const params = manifestSandbox(s).params;
    expect(params.map((p) => [p.name, p.kind, p.source])).toEqual([
      ["model", "model", "sdk"],
      ["system", "prompt", "sdk"],
      ["tools", "tools", "sdk"],
    ]);
    const tools = params.find((p) => p.name === "tools");
    expect(tools?.kind === "tools" && tools.default.map((t) => [t.name, t.hint])).toEqual([
      ["searchDocs", "readOnly"],
      ["createTicket", "sideEffect"],
      ["askExpert", "none"],
    ]);
  });

  it("lets a declared param win on a name clash, and marks it declared", () => {
    const declared = defineSandbox("auto", {
      params: { system: prompt("Declared."), model: model("openai/gpt-5") },
      input: chat(),
      run: async () => "done",
    });
    const params = manifestSandbox(withSdkParams(declared, capture)).params;
    expect(params.map((p) => [p.name, p.default, p.source]).slice(0, 2)).toEqual([
      ["system", "Declared.", "declared"],
      ["model", "openai/gpt-5", "declared"],
    ]);
    expect(params.filter((p) => p.source === "sdk").map((p) => p.name)).toEqual(["tools"]);
  });

  it("skips a catalog id that is not a valid param name", () => {
    const s = withSdkParams(bare, {
      ...capture,
      reads: [{ kind: "prompt", id: "support.system", default: "x" }],
    });
    expect(Object.keys(s.params)).toEqual(["tools"]);
  });

  it("returns the same sandbox when the capture adds nothing", () => {
    const s = withSdkParams(bare, capture);
    expect(withSdkParams(s, capture)).toBe(s);
  });
});

describe("captureSetup", () => {
  it("collects the catalog reads and SDK registrations made while loading", async () => {
    const { capture: got } = await captureSetup(async () => {
      sdkRegisterTools({ searchDocs });
      sdkRead("prompt", "system", "d");
    });
    expect(got.reads).toEqual([{ kind: "prompt", id: "system", default: "d" }]);
    expect(got.tools.map((t) => t.id)).toEqual(["searchDocs"]);
  });
});

describe("a run of sdk params", () => {
  const agent = withSdkParams(
    defineSandbox("auto", {
      input: chat(),
      run: async () => ({
        system: sdkRead("prompt", "system", "You answer from the docs."),
        model: sdkRead("model", "model", "anthropic/claude-haiku-5-5"),
        tools: Object.keys(sdkToolset({ searchDocs, createTicket, askExpert })),
      }),
    }),
    capture,
  );
  const input = { messages: [{ role: "user", content: "hi" }] };

  it("serves overrides of sdk prompt, model and tools params to the code's reads", async () => {
    const r = await runSandbox(agent, {
      input,
      overrides: {
        system: "Overridden.",
        model: "openai/gpt-5",
        tools: [
          { name: "searchDocs" },
          { name: "createTicket" },
          { name: "askExpert", enabled: false },
        ],
      },
    });
    expect(r.output).toEqual({
      system: "Overridden.",
      model: "openai/gpt-5",
      tools: ["searchDocs", "createTicket"],
    });
    expect([...r.overrides].sort()).toEqual(["model", "system", "tools"]);
  });

  it("runs sdk tools in their modes: a sideEffect tool is faked by default", async () => {
    const calls: string[] = [];
    const runAgent = withSdkParams(
      defineSandbox("auto", {
        input: chat(),
        run: async () => {
          const t = sdkToolset({ createTicket });
          return t.createTicket.execute();
        },
      }),
      capture,
    );
    const r = await runSandbox(runAgent, {
      input,
      toolChannel: {
        fake: async (req) => {
          calls.push(req.tool);
          return { result: { id: "fake" }, isError: false, source: "generated" };
        },
        confirm: async () => ({ decision: "reject" }),
      },
    });
    expect(calls).toEqual(["createTicket"]);
    expect(r.output).toEqual({ id: "fake" });
    expect(r.toolModes.createTicket).toBe("fake");
  });

  it("reports a catalog read the setup did not reach, so the runner can add it", async () => {
    const lazy = defineSandbox("auto", {
      input: chat(),
      run: async () => sdkRead("prompt", "followUp", "Ask again."),
    });
    const r = await runSandbox(lazy, { input });
    const grown = withSdkParams(lazy, { reads: r.catalogReads, tools: [], skills: [] });
    expect(manifestSandbox(grown).params).toEqual([
      { name: "followUp", kind: "prompt", default: "Ask again.", source: "sdk" },
    ]);
  });
});
