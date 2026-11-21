import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { aiSdkModels } from "./ai-sdk.js";
import { executeRun } from "./dev/execute.js";
import { buildManifest, ModelResolutionError, twin } from "./index.js";
import { esmEntry, packageDir } from "./project-packages.js";

// The AI SDK resolver imports `ai` and the providers from the project of the
// twin file, never from where @ratel-ai/twin is installed (it has its own dev
// copy of ai@7). Each project here is a throwaway folder whose stand-in
// packages return a marker, so the test sees which copy was loaded.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A project with the given stand-in packages and a twin file path inside a subfolder. */
function project(packages: Record<string, string>): { root: string; twinFile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "twin-project-")));
  dirs.push(root);
  for (const [name, source] of Object.entries(packages)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        type: "module",
        exports: { ".": { types: "./index.d.ts", import: "./index.mjs", require: "./index.cjs" } },
      }),
    );
    writeFileSync(join(dir, "index.mjs"), source);
    writeFileSync(join(dir, "index.cjs"), "throw new Error('the CJS entry must not load');");
  }
  mkdirSync(join(root, "agents"), { recursive: true });
  return { root, twinFile: join(root, "agents", "docs.twin.ts") };
}

const PROJECT_AI = `export const createGateway = ({ apiKey }) => (id) => ({ from: "project-ai", id, apiKey });`;
const PROJECT_ANTHROPIC = `export const createAnthropic = ({ apiKey }) => (id) => ({ from: "project-anthropic", id });`;
const MODEL = "anthropic/claude-sonnet-5-5";

describe("packages from the twin file's project", () => {
  it("finds a package in a node_modules above the twin file and picks its ESM entry", () => {
    const { root, twinFile } = project({ ai: PROJECT_AI });
    const dir = packageDir("ai", join(twinFile, ".."));
    expect(dir).toBe(join(root, "node_modules", "ai"));
    expect(esmEntry(dir as string)).toBe("./index.mjs");
  });

  it("loads ai for the gateway from the project, not the twin package's own ai@7", async () => {
    const { twinFile } = project({ ai: PROJECT_AI });
    const resolve = aiSdkModels({ env: { AI_GATEWAY_API_KEY: "gw_test" } });
    expect(await resolve(MODEL, { from: twinFile })).toEqual({
      from: "project-ai",
      id: MODEL,
      apiKey: "gw_test",
    });
  });

  it("loads the provider package from the project", async () => {
    const { twinFile } = project({ ai: PROJECT_AI, "@ai-sdk/anthropic": PROJECT_ANTHROPIC });
    const resolve = aiSdkModels({ env: { ANTHROPIC_API_KEY: "sk-ant" } });
    expect(await resolve(MODEL, { from: twinFile })).toEqual({
      from: "project-anthropic",
      id: "claude-sonnet-5-5",
    });
  });

  it("rejects with a clear reason when the project has no ai, and never falls back to the twin package's copy", async () => {
    const { root, twinFile } = project({});
    const resolve = aiSdkModels({ env: { AI_GATEWAY_API_KEY: "gw_test" } });
    const run = resolve(MODEL, { from: twinFile });
    await expect(run).rejects.toThrow(ModelResolutionError);
    await expect(run).rejects.toThrow(
      `cannot run ${MODEL}: the ai package is not installed in the project at ${join(root, "agents")}. Install it there`,
    );
  });

  it("lists callable providers from the same project", () => {
    const env = { AI_GATEWAY_API_KEY: "gw", ANTHROPIC_API_KEY: "sk-ant" };
    const resolve = aiSdkModels();
    const bare = project({});
    const full = project({ ai: PROJECT_AI, "@ai-sdk/anthropic": PROJECT_ANTHROPIC });
    expect(resolve.callableProviders?.(env, { from: bare.twinFile })).toEqual([]);
    expect(resolve.callableProviders?.(env, { from: full.twinFile })).toEqual([
      { provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] },
      { provider: "gateway", keys: ["AI_GATEWAY_API_KEY"] },
    ]);
  });

  it("builds the manifest's providers from each twin file's project", () => {
    const { root } = project({ ai: PROJECT_AI });
    const chatTwin = twin("docs-agent", {
      params: { model: twin.model(MODEL) },
      input: twin.chat(),
      resolve: aiSdkModels(),
      run: () => "",
    });
    const manifest = buildManifest({
      twins: [{ twin: chatTwin, file: "agents/docs.twin.ts" }],
      root,
      env: { AI_GATEWAY_API_KEY: "gw", ANTHROPIC_API_KEY: "sk-ant" },
    });
    expect(manifest.providers).toEqual([{ provider: "gateway", keys: ["AI_GATEWAY_API_KEY"] }]);
  });

  it("hands run() the project's model in a ratel dev run", async () => {
    const { twinFile } = project({ ai: PROJECT_AI });
    const previous = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "gw_test";
    try {
      const chatTwin = twin("docs-agent", {
        params: { model: twin.model(MODEL) },
        input: twin.chat(),
        resolve: aiSdkModels(),
        run: ({ params }) => params.model,
      });
      const { trace } = await import("@opentelemetry/api");
      const result = await executeRun(chatTwin, {
        runId: "run_1",
        twinFile,
        start: {
          twinId: "docs-agent",
          input: { messages: [{ role: "user", content: "hi" }] },
          params: {},
          configHash: "0".repeat(64),
        },
        tracer: trace.getTracer("t"),
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      expect(result).toMatchObject({ status: "ok", output: { from: "project-ai" } });
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previous;
    }
  });
});
