import { describe, expect, it } from "vitest";
import { aiSdkCallableProviders, aiSdkModels } from "./ai-sdk.js";
import { Runs, type RunsEffect } from "./dev/runs.js";
import { buildManifest, ModelResolutionError } from "./index.js";
import { docsSandbox } from "./test-support/docs.sandbox.js";

// Model resolution of an AI SDK sandbox (spec §3.5): AI Gateway when its key is
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
    await expect(resolve(MODEL)).rejects.toThrow("Install it there, or set AI_GATEWAY_API_KEY");
  });

  it("rejects a prefix without a built-in provider unless the gateway is set", async () => {
    await expect(aiSdkModels({ env: { MISTRAL_API_KEY: "x" } })("mistral/large")).rejects.toThrow(
      'there is no built-in AI SDK provider for "mistral"',
    );
  });
});

describe("callable providers of an AI SDK sandbox", () => {
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

  it("puts only callable providers in the manifest of an AI SDK sandbox", () => {
    const resolve = aiSdkModels({ installed: installedOnly("@ai-sdk/anthropic") });
    const manifest = buildManifest({
      sandboxes: [{ sandbox: docsSandbox(resolve) }],
      env: { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" },
    });
    expect(manifest.providers).toEqual([{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }]);
    expect(JSON.stringify(manifest)).not.toContain("sk-ant");
  });

  it("lists Amazon Bedrock with the names of the AWS variables that are set, never their values", () => {
    const env = {
      AWS_PROFILE: "staging-profile",
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIATEST",
    };
    expect(aiSdkCallableProviders(env, installedOnly("@ai-sdk/amazon-bedrock"))).toEqual([
      { provider: "amazon-bedrock", keys: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID"] },
    ]);
    expect(aiSdkCallableProviders(env, installedOnly())).toEqual([]);
    const manifest = buildManifest({
      sandboxes: [
        {
          sandbox: docsSandbox(aiSdkModels({ installed: installedOnly("@ai-sdk/amazon-bedrock") })),
        },
      ],
      env,
    });
    expect(manifest.providers).toEqual([
      { provider: "amazon-bedrock", keys: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID"] },
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/staging-profile|AKIATEST/);
  });
});

describe("aiSdkModels on Amazon Bedrock", () => {
  const BEDROCK = "amazon-bedrock/eu.anthropic.claude-haiku-5-5";
  const CHAIN = () => Promise.resolve({ accessKeyId: "chain", secretAccessKey: "chain" });

  /** A stub project: records each import and the settings of each Bedrock provider. */
  function stubProject() {
    const loaded: string[] = [];
    const settings: Record<string, unknown>[] = [];
    const load = async (specifier: string): Promise<Record<string, unknown>> => {
      loaded.push(specifier);
      if (specifier === "@ai-sdk/amazon-bedrock")
        return {
          createAmazonBedrock: (s: Record<string, unknown>) => {
            settings.push(s);
            return (id: string) => ({ provider: "amazon-bedrock", modelId: id });
          },
        };
      if (specifier === "@aws-sdk/credential-providers")
        return { fromNodeProviderChain: () => CHAIN };
      throw new Error(`Cannot find package '${specifier}'`);
    };
    return { loaded, settings, load };
  }

  it("resolves with the AWS credential chain of the project when AWS_PROFILE is set", async () => {
    const project = stubProject();
    const resolve = aiSdkModels({
      env: { AWS_PROFILE: "staging", AWS_REGION: "eu-central-1" },
      load: project.load,
    });
    expect(await resolve(BEDROCK)).toEqual({
      provider: "amazon-bedrock",
      modelId: "eu.anthropic.claude-haiku-5-5",
    });
    expect(project.settings).toEqual([{ region: "eu-central-1", credentialProvider: CHAIN }]);
    expect(project.loaded).toEqual(["@ai-sdk/amazon-bedrock", "@aws-sdk/credential-providers"]);
  });

  it("lets the package read static keys from the environment, without the credential chain", async () => {
    const project = stubProject();
    const resolve = aiSdkModels({
      env: { AWS_ACCESS_KEY_ID: "AKIATEST", AWS_DEFAULT_REGION: "eu-west-1" },
      load: project.load,
    });
    await resolve(BEDROCK);
    expect(project.settings).toEqual([{ region: "eu-west-1" }]);
    expect(project.loaded).toEqual(["@ai-sdk/amazon-bedrock"]);
  });

  it("rejects with a clear reason when there are no AWS credentials or no region", async () => {
    const project = stubProject();
    await expect(aiSdkModels({ env: {}, load: project.load })(BEDROCK)).rejects.toThrow(
      "set AI_GATEWAY_API_KEY, or set AWS_PROFILE (or AWS_ACCESS_KEY_ID, AWS_BEARER_TOKEN_BEDROCK, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_CONTAINER_CREDENTIALS_FULL_URI, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) and install @ai-sdk/amazon-bedrock",
    );
    await expect(
      aiSdkModels({ env: { AWS_PROFILE: "staging" }, load: project.load })(BEDROCK),
    ).rejects.toThrow("set AWS_REGION");
  });

  it("names the credential package when AWS_PROFILE needs it and the project lacks it", async () => {
    const resolve = aiSdkModels({
      env: { AWS_PROFILE: "staging", AWS_REGION: "eu-central-1" },
      load: async (specifier) => {
        if (specifier === "@ai-sdk/amazon-bedrock")
          return { createAmazonBedrock: () => () => ({}) };
        throw new Error(`Cannot find package '${specifier}'`);
      },
    });
    await expect(resolve(BEDROCK)).rejects.toThrow("install @aws-sdk/credential-providers");
  });

  it("generates fakes with a small Bedrock model when Bedrock is the only callable provider", async () => {
    const project = stubProject();
    const asked: unknown[] = [];
    const resolve = aiSdkModels({
      env: { AWS_PROFILE: "staging", AWS_REGION: "eu-central-1" },
      installed: (specifier) => specifier === "@ai-sdk/amazon-bedrock" || specifier === "ai",
      load: async (specifier) =>
        specifier === "ai"
          ? {
              generateText: async (options: { model: unknown }) => {
                asked.push(options.model);
                return { text: '{"ticketId":"T-9"}' };
              },
            }
          : project.load(specifier),
    });
    const answer = await resolve.generateFake?.(
      { callId: "c1", tool: "createTicket", description: "Open a ticket.", args: {}, messages: [] },
      new AbortController().signal,
    );
    expect(answer).toEqual({ result: { ticketId: "T-9" }, isError: false, source: "generated" });
    expect(asked).toEqual([
      { provider: "amazon-bedrock", modelId: "global.anthropic.claude-haiku-5-5" },
    ]);
  });
});

describe("run.start for an AI SDK sandbox", () => {
  const T0 = new Date("2026-11-20T10:00:00Z");
  const start = (params: Record<string, unknown>) => ({
    v: 1 as const,
    type: "run.start",
    id: "c_1",
    ts: T0.toISOString(),
    runId: "run_1",
    payload: {
      sandboxId: "docs-agent",
      input: { messages: [{ role: "user", content: "hi" }] },
      params,
      configHash: "0".repeat(64),
    },
  });
  const manifestWith = (env: Record<string, string>) =>
    buildManifest({
      sandboxes: [{ sandbox: docsSandbox(aiSdkModels({ installed: () => true })) }],
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
              "cannot run anthropic/claude-sonnet-5-5 on this runner: set AI_GATEWAY_API_KEY with the ai package installed in the project, or install @ai-sdk/anthropic there and set its API key (callable providers: none)",
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
