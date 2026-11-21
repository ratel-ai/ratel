import { describe, expect, it } from "vitest";
import { aiSdkCallableProviders, aiSdkModels } from "./ai-sdk.js";
import { Runs, type RunsEffect } from "./dev/runs.js";
import { buildManifest, ModelResolutionError } from "./index.js";
import { docsTwin } from "./test-support/docs.twin.js";

// Model resolution of an AI SDK twin (spec §3.5): AI Gateway when its key is
// set, else the project's own @ai-sdk/<provider> package with its key.

const MODEL = "anthropic/claude-sonnet-5-5";

describe("aiSdkModels", () => {
  it("resolves through AI Gateway when AI_GATEWAY_API_KEY is set, with the full provider/model id", async () => {
    const resolve = aiSdkModels({
      env: { AI_GATEWAY_API_KEY: "gw_test", ANTHROPIC_API_KEY: "sk" },
    });
    const model = (await resolve(MODEL)) as { provider: string; modelId: string };
    expect(model.provider).toBe("gateway");
    expect(model.modelId).toBe(MODEL);
  });

  it("resolves through the installed provider package with its key when there is no gateway key", async () => {
    const resolve = aiSdkModels({ env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
    const model = (await resolve(MODEL)) as { provider: string; modelId: string };
    expect(model.provider).toMatch(/^anthropic/);
    expect(model.modelId).toBe("claude-sonnet-5-5");
  });

  it("imports only the package the model needs", async () => {
    const loaded: string[] = [];
    const resolve = aiSdkModels({
      env: { OPENAI_API_KEY: "sk-test" },
      load: async (specifier) => {
        loaded.push(specifier);
        return { createOpenAI: () => (id: string) => ({ id }) };
      },
    });
    expect(await resolve("openai/gpt-6")).toEqual({ id: "gpt-6" });
    expect(loaded).toEqual(["@ai-sdk/openai"]);
  });

  it("rejects with a clear reason when there is neither a gateway key nor a provider key", async () => {
    const resolve = aiSdkModels({ env: {} });
    await expect(resolve(MODEL)).rejects.toThrow(ModelResolutionError);
    await expect(resolve(MODEL)).rejects.toThrow(
      "cannot run anthropic/claude-sonnet-5-5: set AI_GATEWAY_API_KEY, or set ANTHROPIC_API_KEY and install @ai-sdk/anthropic",
    );
  });

  it("rejects with a clear reason when the provider package is not installed", async () => {
    const resolve = aiSdkModels({
      env: { ANTHROPIC_API_KEY: "sk" },
      load: async (specifier) => {
        throw new Error(`Cannot find package '${specifier}'`);
      },
    });
    await expect(resolve(MODEL)).rejects.toThrow(
      "@ai-sdk/anthropic is not installed in this project. Install it, or set AI_GATEWAY_API_KEY",
    );
  });

  it("rejects a prefix without a built-in provider unless the gateway is set", async () => {
    await expect(aiSdkModels({ env: { MISTRAL_API_KEY: "x" } })("mistral/large")).rejects.toThrow(
      'there is no built-in AI SDK provider for "mistral"',
    );
  });
});

describe("callable providers of an AI SDK twin", () => {
  const installedOnly =
    (...packages: string[]) =>
    (specifier: string) =>
      packages.includes(specifier);

  it("lists the gateway and each provider with a key and an installed package, by key name", () => {
    const env = {
      AI_GATEWAY_API_KEY: "gw",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
    };
    expect(aiSdkCallableProviders(env, installedOnly("ai", "@ai-sdk/anthropic"))).toEqual([
      { provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] },
      { provider: "gateway", keys: ["AI_GATEWAY_API_KEY"] },
    ]);
  });

  it("puts only callable providers in the manifest of an AI SDK twin", () => {
    const resolve = aiSdkModels({ installed: installedOnly("@ai-sdk/anthropic") });
    const manifest = buildManifest({
      twins: [{ twin: docsTwin(resolve) }],
      env: { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" },
    });
    expect(manifest.providers).toEqual([{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }]);
    expect(JSON.stringify(manifest)).not.toContain("sk-ant");
  });
});

describe("run.start for an AI SDK twin", () => {
  const T0 = new Date("2026-11-20T10:00:00Z");
  const start = (params: Record<string, unknown>) => ({
    v: 1 as const,
    type: "run.start",
    id: "c_1",
    ts: T0.toISOString(),
    runId: "run_1",
    payload: {
      twinId: "docs-agent",
      input: { messages: [{ role: "user", content: "hi" }] },
      params,
      configHash: "0".repeat(64),
    },
  });
  const manifestWith = (env: Record<string, string>) =>
    buildManifest({
      twins: [{ twin: docsTwin(aiSdkModels({ installed: () => true })) }],
      env,
    });
  const runs = () => new Runs({ stamp: { nextId: () => "w_1", now: () => T0 }, maxConcurrency: 1 });
  const sent = (effects: RunsEffect[]) =>
    effects.flatMap((e) => (e.type === "send" ? [e.frame] : []));

  it("is rejected with a clear reason when no provider can call the model", () => {
    const [reject] = sent(runs().start(start({}), manifestWith({}), T0));
    expect(reject).toMatchObject({
      type: "run.reject",
      payload: {
        reason: "invalid_params",
        errors: [
          {
            param: "model",
            message:
              "cannot run anthropic/claude-sonnet-5-5 on this runner: set AI_GATEWAY_API_KEY, or install the @ai-sdk/anthropic package and set its API key (callable providers: none)",
          },
        ],
      },
    });
  });

  it("is acked when the gateway can call it, also for another provider's model", () => {
    const effects = runs().start(
      start({ model: "openai/gpt-6" }),
      manifestWith({ AI_GATEWAY_API_KEY: "gw" }),
      T0,
    );
    expect(sent(effects)[0]?.type).toBe("run.ack");
  });

  it("is rejected when a chat input has no messages", () => {
    const bad = { ...start({}), payload: { ...start({}).payload, input: { text: "hi" } } };
    const [reject] = sent(runs().start(bad, manifestWith({ AI_GATEWAY_API_KEY: "gw" }), T0));
    expect(reject?.payload).toMatchObject({
      reason: "invalid_params",
      errors: [{ param: "input", message: "must have a non-empty messages array" }],
    });
  });
});
