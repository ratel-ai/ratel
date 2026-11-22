import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ratel } from "@ratel-ai/sdk/experimental/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SDK_SKILLS_PARAM, withSdkParams } from "./auto-params.js";
import { captureSetup, REGISTRY_KEY } from "./catalog.js";
import { manifestSandbox } from "./manifest.js";
import type { ParamMap } from "./params.js";
import { runSandbox } from "./run.js";
import { defineSandbox, type Sandbox, structured } from "./sandbox.js";
import { sdkRegisterSkills } from "./test-support/fake-sdk.js";
import { RATEL_TOOL_MODE, type ToolChannel, tools } from "./tools.js";

// Skills registered on the SDK become the `skills` param (the tools shape: enabled,
// description, mode). The code offers them through `ratel.skills()` of the real
// `@ratel-ai/sdk/experimental/catalog`; a run's overrides apply there.

const summarizeDoc = {
  id: "summarizeDoc",
  name: "summarizeDoc",
  description: "Summarize one docs page.",
  body: "Read the page, then answer in three bullets.",
  annotations: { readOnlyHint: true },
};
const escalate = {
  id: "escalate",
  name: "escalate",
  description: "Escalate to a human.",
  body: "Collect the logs first.",
};
const codeSkills = [summarizeDoc, escalate];

/** What the agent offers the model, and loads, through the SDK. */
async function offer(load: readonly string[] = []) {
  const view = ratel.skills(codeSkills);
  const loaded: Record<string, string> = {};
  for (const id of load) {
    const skill = view.find((s) => s.id === id);
    if (skill) loaded[id] = await skill.load();
  }
  return { offered: view.map((s) => [s.id, s.description]), loaded };
}

async function load(params: ParamMap = {}, toLoad: readonly string[] = []): Promise<Sandbox> {
  const { result, capture } = await captureSetup(async () => {
    sdkRegisterSkills(codeSkills);
    return defineSandbox("agent", {
      params,
      input: structured<{ q: string }>({ type: "object" }),
      run: async () => offer(toLoad),
    });
  });
  return withSdkParams(result as Sandbox, capture);
}

function channel(answers: { fake?: unknown; confirm?: "approve" | "reject" } = {}) {
  const asked: string[] = [];
  const ch: ToolChannel = {
    fake: async (req) => {
      asked.push(`fake ${req.tool}`);
      return { result: answers.fake ?? "faked body", isError: false, source: "pinned" };
    },
    confirm: async (req) => {
      asked.push(`confirm ${req.tool}`);
      return { decision: answers.confirm ?? "approve" };
    },
  };
  return { ch, asked };
}

const input = { q: "hi" };

beforeEach(() => {
  delete (globalThis as { [REGISTRY_KEY]?: unknown })[REGISTRY_KEY];
});

describe("skills as a param", () => {
  it("lists each SDK skill with source sdk, its description and its mode", async () => {
    const agent = await load();
    const [param] = manifestSandbox(agent).params;
    expect(param?.name).toBe(SDK_SKILLS_PARAM);
    expect(param?.source).toBe("sdk");
    expect(
      param?.kind === "tools" && param.default.map((s) => [s.name, s.description, s.hint]),
    ).toEqual([
      ["summarizeDoc", "Summarize one docs page.", "readOnly"],
      ["escalate", "Escalate to a human.", "none"],
    ]);
  });

  it("offers every skill and loads a real one's body by default", async () => {
    const { ch, asked } = channel();
    const r = await runSandbox(await load({}, ["summarizeDoc"]), { input, toolChannel: ch });
    expect(r.output).toEqual({
      offered: [
        ["summarizeDoc", "Summarize one docs page."],
        ["escalate", "Escalate to a human."],
      ],
      loaded: { summarizeDoc: summarizeDoc.body },
    });
    expect(asked).toEqual([]);
    expect(r.toolModes).toEqual({ summarizeDoc: "real", escalate: "confirm" });
  });

  it("leaves a disabled skill out and offers an edited description", async () => {
    const r = await runSandbox(await load(), {
      input,
      overrides: {
        skills: [
          { name: "summarizeDoc", description: "Edited." },
          { name: "escalate", enabled: false },
        ],
      },
    });
    expect((r.output as { offered: unknown }).offered).toEqual([["summarizeDoc", "Edited."]]);
    expect(r.overrides).toEqual(["skills"]);
  });

  it("fakes a load through tool.fake and asks a confirm skill through tool.confirm", async () => {
    const { ch, asked } = channel({ fake: "a pinned body" });
    const r = await runSandbox(await load({}, ["summarizeDoc", "escalate"]), {
      input,
      toolChannel: ch,
      toolModes: { summarizeDoc: "fake" },
    });
    expect((r.output as { loaded: unknown }).loaded).toEqual({
      summarizeDoc: "a pinned body",
      escalate: escalate.body,
    });
    expect(asked).toEqual(["fake summarizeDoc", "confirm escalate"]);
  });

  it("lets a declared tools-shaped skills param win, still served to ratel.skills()", async () => {
    const declaredSkills = tools(
      { summarizeDoc: { description: "Declared description.", inputSchema: {} } },
      { summarizeDoc: { readOnly: true } },
    );
    const agent = await load({ skills: declaredSkills }, ["summarizeDoc"]);
    expect(manifestSandbox(agent).params.map((p) => [p.name, p.source])).toEqual([
      ["skills", "declared"],
    ]);
    const r = await runSandbox(agent, { input });
    expect(r.output).toEqual({
      // escalate is not in the declared param: it is offered as the code has it.
      offered: [
        ["summarizeDoc", "Declared description."],
        ["escalate", "Escalate to a human."],
      ],
      loaded: { summarizeDoc: summarizeDoc.body },
    });
  });
});

describe("the skill span", () => {
  let provider: NodeTracerProvider | undefined;
  afterEach(async () => {
    await provider?.shutdown();
    trace.disable();
    context.disable();
  });

  it("carries ratel.tool.mode", async () => {
    const memory = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    provider.register();
    const { ch } = channel();
    await runSandbox(await load({}, ["summarizeDoc", "escalate"]), {
      input,
      toolChannel: ch,
      toolModes: { summarizeDoc: "fake" },
    });
    const modes = Object.fromEntries(
      memory
        .getFinishedSpans()
        .map((s) => [s.attributes["gen_ai.tool.name"], s.attributes[RATEL_TOOL_MODE]]),
    );
    expect(modes).toEqual({ summarizeDoc: "fake", escalate: "confirm" });
  });
});
