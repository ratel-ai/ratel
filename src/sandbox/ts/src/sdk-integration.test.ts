import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ratel, resetCatalogForTest } from "@ratel-ai/sdk/experimental/catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSdkParams } from "./auto-params.js";
import { captureSetup, REGISTRY_KEY } from "./catalog.js";
import { configHash } from "./hash.js";
import { manifestSandbox } from "./manifest.js";
import type { ParamMap } from "./params.js";
import { model, prompt } from "./params.js";
import { runSandbox } from "./run.js";
import { defineSandbox, type Sandbox, structured } from "./sandbox.js";
import { sdkRegisterTools } from "./test-support/fake-sdk.js";
import { tools } from "./tools.js";

// The real `@ratel-ai/sdk/experimental/catalog` with the sandbox runner: what the
// code reads through ratel.prompt/model/toolset in a run, and what the manifest says.

const FALLBACK_SYSTEM = "You answer from the docs.";
const FALLBACK_MODEL = "anthropic/claude-haiku-5-5";
const searchDocs = {
  description: "Search the docs.",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  execute: async () => ["page"],
};
const askExpert = {
  description: "Ask an expert.",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  execute: async () => "ok",
};
const codeTools = { searchDocs, askExpert };

/** What the agent reads, on load and on each run, through the SDK. */
function readConfig() {
  return {
    system: ratel.prompt("system", FALLBACK_SYSTEM),
    model: ratel.model("model", FALLBACK_MODEL),
    tools: Object.keys(ratel.toolset(codeTools)),
  };
}

/** Loads an agent the way `ratel` loads a sandbox file: the import reads and registers. */
async function load(params: ParamMap = {}): Promise<Sandbox> {
  const { result, capture } = await captureSetup(async () => {
    sdkRegisterTools(codeTools);
    readConfig();
    return defineSandbox("agent", {
      params,
      input: structured<{ q: string }>({ type: "object" }),
      run: async () => readConfig(),
    });
  });
  return withSdkParams(result as Sandbox, capture);
}

const input = { q: "hi" };
let dir: string;

function writeCatalog(content: unknown): void {
  writeFileSync(join(dir, "ratel.catalog.json"), JSON.stringify(content));
  resetCatalogForTest();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ratel-sdk-int-"));
  vi.stubEnv("RATEL_CATALOG_FILE", join(dir, "ratel.catalog.json"));
  delete (globalThis as { [REGISTRY_KEY]?: unknown })[REGISTRY_KEY];
  resetCatalogForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("precedence: run override > catalog > fallback", () => {
  it("reads the catalog value with no override, and lists it as the default", async () => {
    writeCatalog({ prompts: { system: "From the catalog." }, models: { model: "openai/gpt-5" } });
    const agent = await load();
    const params = manifestSandbox(agent).params;
    expect(params.map((p) => [p.name, p.default, p.source]).slice(0, 2)).toEqual([
      ["system", "From the catalog.", "sdk"],
      ["model", "openai/gpt-5", "sdk"],
    ]);
    const r = await runSandbox(agent, { input });
    expect(r.output).toMatchObject({ system: "From the catalog.", model: "openai/gpt-5" });
  });

  it("reads the fallback with no catalog file", async () => {
    const r = await runSandbox(await load(), { input });
    expect(r.output).toMatchObject({ system: FALLBACK_SYSTEM, model: FALLBACK_MODEL });
  });

  it("reads an explicit run override over the catalog", async () => {
    writeCatalog({ prompts: { system: "From the catalog." }, models: { model: "openai/gpt-5" } });
    const r = await runSandbox(await load(), {
      input,
      overrides: { system: "Overridden." },
    });
    expect(r.output).toMatchObject({ system: "Overridden.", model: "openai/gpt-5" });
    expect(r.overrides).toEqual(["system"]);
  });
});

describe("a declared param that wins a clash", () => {
  it("is what the code reads for a prompt and a model, and stays declared", async () => {
    writeCatalog({ prompts: { system: "From the catalog." } });
    const agent = await load({ system: prompt("Declared."), model: model("openai/gpt-5.1") });
    const params = manifestSandbox(agent).params;
    expect(params.map((p) => [p.name, p.source])).toEqual([
      ["system", "declared"],
      ["model", "declared"],
      ["tools", "sdk"],
    ]);
    expect((await runSandbox(agent, { input })).output).toMatchObject({
      system: "Declared.",
      model: "openai/gpt-5.1",
    });
    const changed = await runSandbox(agent, {
      input,
      overrides: { system: "Run value.", model: "openai/gpt-5" },
    });
    expect(changed.output).toMatchObject({ system: "Run value.", model: "openai/gpt-5" });
  });

  it("serves a declared tools param that covers the SDK tools, with its edits", async () => {
    const agent = await load({ tools: tools(codeTools, { searchDocs: { readOnly: true } }) });
    expect(manifestSandbox(agent).params.map((p) => [p.name, p.source])).toEqual([
      ["tools", "declared"],
      ["system", "sdk"],
      ["model", "sdk"],
    ]);
    const r = await runSandbox(agent, {
      input,
      overrides: { tools: [{ name: "searchDocs" }, { name: "askExpert", enabled: false }] },
    });
    expect(r.output).toMatchObject({ tools: ["searchDocs"] });
    // askExpert has no hint in the declared param: confirm, not the SDK's readOnlyHint.
    expect(r.toolModes).toEqual({ searchDocs: "real", askExpert: "confirm" });
  });
});

describe("config hash", () => {
  it("keeps the production hash on a baseline run, and changes with the catalog value", async () => {
    writeCatalog({ prompts: { system: "From the catalog." } });
    const agent = await load();
    const baseline = await runSandbox(agent, { input });
    // What production stamps for the values it reads: the catalog value and the fallback.
    const production = configHash({
      system: "From the catalog.",
      model: FALLBACK_MODEL,
      tools: [
        { name: "searchDocs", description: searchDocs.description },
        { name: "askExpert", description: askExpert.description },
      ],
    });
    expect(baseline.configHash).toBe(production);

    delete (globalThis as { [REGISTRY_KEY]?: unknown })[REGISTRY_KEY];
    writeCatalog({ prompts: { system: "A new catalog value." } });
    const reloaded = await runSandbox(await load(), { input });
    expect(reloaded.configHash).not.toBe(baseline.configHash);
  });
});
