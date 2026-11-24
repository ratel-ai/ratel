import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { modelIdFor, resolveModelVendor } from "./config";
import { FEATURES, featureRow } from "./features";
import { VENDORS } from "./vendors";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

const KEY = "sk-test";
const resolve = (env: Record<string, string | undefined>, environment = "production") =>
  resolveModelVendor(cfg(env), environment);

test("unset MODEL_PROVIDER is Claude exactly as ANTHROPIC_BACKEND and ANTHROPIC_API_KEY decide", () => {
  assert.equal(resolve({}), null);
  assert.deepEqual(resolve({ ANTHROPIC_API_KEY: KEY }), { name: "claude" });
  assert.deepEqual(resolve({ ANTHROPIC_BACKEND: "bedrock" }), { name: "claude" });
  assert.equal(resolve({ ANTHROPIC_API_KEY: "REPLACE_ME" }), null);
  assert.equal(resolve({ ANTHROPIC_BACKEND: "bedrok", ANTHROPIC_API_KEY: KEY }), null);
  assert.equal(resolve({ ANTHROPIC_BACKEND: "bedrock", AWS_BEARER_TOKEN_BEDROCK: "token" }), null);
});

test("claude by name is the same, and needs its key", () => {
  assert.deepEqual(resolve({ MODEL_PROVIDER: " Claude ", ANTHROPIC_API_KEY: KEY }), {
    name: "claude",
  });
  assert.equal(resolve({ MODEL_PROVIDER: "claude" }), null);
});

test("a hosted vendor needs only its own key", () => {
  for (const [name, variable, baseUrl] of [
    ["openai", "OPENAI_API_KEY", "https://api.openai.com/v1"],
  ] as const) {
    assert.deepEqual(resolve({ MODEL_PROVIDER: name, [variable]: KEY }), {
      name,
      baseUrl,
      apiKey: KEY,
    });
    assert.equal(resolve({ MODEL_PROVIDER: name }), null, name);
    assert.equal(resolve({ MODEL_PROVIDER: name, [variable]: "REPLACE_ME" }), null, name);
    assert.equal(resolve({ MODEL_PROVIDER: name, ANTHROPIC_API_KEY: KEY }), null, name);
  }
});

test("a vendor is never inferred from a key", () => {
  assert.equal(resolve({ OPENAI_API_KEY: KEY }), null);
  assert.equal(resolve({ SAGE_API_KEY: KEY, GEMINI_API_KEY: KEY }), null);
});

test("a vendor's key goes only to that vendor: another address needs MODEL_API_KEY", () => {
  const base = {
    MODEL_PROVIDER: "openai",
    MODEL_BASE_URL: "https://gw.test/v1",
    OPENAI_API_KEY: KEY,
  };
  assert.equal(resolve(base), null);
  assert.deepEqual(resolve({ ...base, MODEL_API_KEY: "gw-key" }), {
    name: "openai",
    baseUrl: "https://gw.test/v1",
    apiKey: "gw-key",
  });
});

test("MODEL_API_KEY is ahead of the vendor's own variable", () => {
  assert.equal(
    resolve({ MODEL_PROVIDER: "openai", MODEL_API_KEY: "own", OPENAI_API_KEY: KEY })?.apiKey,
    "own",
  );
});

test("a self-hosted server needs its address, and its key is optional", () => {
  for (const name of ["ollama", "llama.cpp", "vllm", "litellm", "custom"] as const) {
    assert.equal(resolve({ MODEL_PROVIDER: name }), null, name);
    assert.equal(resolve({ MODEL_PROVIDER: name, MODEL_API_KEY: KEY }), null, name);
    assert.deepEqual(resolve({ MODEL_PROVIDER: name, MODEL_BASE_URL: "http://host:1234/v1/" }), {
      name,
      baseUrl: "http://host:1234/v1",
    });
  }
  // Only a key set for it: a hosted vendor's key stays home.
  assert.equal(
    resolve({ MODEL_PROVIDER: "vllm", MODEL_BASE_URL: "http://host/v1", OPENAI_API_KEY: KEY })
      ?.apiKey,
    undefined,
  );
});

test("a server's plain address is enough; a custom one is used as given", () => {
  for (const name of ["ollama", "llama.cpp", "vllm", "litellm"]) {
    assert.equal(
      resolve({ MODEL_PROVIDER: name, MODEL_BASE_URL: "http://host:11434" })?.baseUrl,
      "http://host:11434/v1",
      name,
    );
  }
  assert.equal(
    resolve({ MODEL_PROVIDER: "custom", MODEL_BASE_URL: "https://host/api" })?.baseUrl,
    "https://host/api",
  );
  assert.equal(resolve({ MODEL_PROVIDER: "ollama", MODEL_BASE_URL: "host:11434" }), null);
});

test("llama.cpp is known by the names people write", () => {
  for (const name of ["llama.cpp", "llamacpp", "llama-cpp", "LLAMA.CPP"]) {
    assert.equal(
      resolve({ MODEL_PROVIDER: name, MODEL_BASE_URL: "http://host/v1" })?.name,
      "llama.cpp",
    );
  }
});

test("gcp needs its project and its location; nothing defaults", () => {
  const env = {
    MODEL_PROVIDER: "gcp",
    GOOGLE_CLOUD_PROJECT: "acme",
    GOOGLE_CLOUD_LOCATION: "eu",
  };
  assert.deepEqual(resolve(env), { name: "gcp", project: "acme", location: "eu" });
  assert.equal(resolve({ ...env, GOOGLE_CLOUD_PROJECT: undefined }), null);
  assert.equal(resolve({ ...env, GOOGLE_CLOUD_LOCATION: undefined }), null);
  // Both land in a URL, so they must look like what they are.
  assert.equal(resolve({ ...env, GOOGLE_CLOUD_LOCATION: "eu.evil.test/" }), null);
  assert.equal(resolve({ ...env, GOOGLE_CLOUD_PROJECT: "a/b" }), null);
});

test("bedrock needs its region, and keeps Claude calls in the region's own geography", () => {
  const at = (region: string, extra = {}) =>
    resolve({ MODEL_PROVIDER: "bedrock", AWS_REGION: region, ...extra });
  assert.deepEqual(at("eu-west-1"), { name: "bedrock", region: "eu-west-1", profile: "eu" });
  assert.equal(at("us-east-1")?.profile, "us");
  assert.equal(at("ap-northeast-1")?.profile, "jp");
  assert.equal(at("ap-southeast-2")?.profile, "au");
  // Elsewhere the geography must be said: nothing is routed worldwide by default.
  assert.equal(at("sa-east-1"), null);
  assert.equal(at("sa-east-1", { BEDROCK_PROFILE: "global" })?.profile, "global");
  assert.equal(at("eu-west-1", { BEDROCK_PROFILE: "global" })?.profile, "global");
  assert.equal(at("eu-west-1", { BEDROCK_PROFILE: "mars" }), null);
  assert.equal(resolve({ MODEL_PROVIDER: "bedrock" }), null);
  assert.equal(at("evil.test/"), null);
  assert.equal(at("eu-west-1", { AWS_BEARER_TOKEN_BEDROCK: "token" })?.apiKey, "token");
});

test("an unknown vendor gives nothing, whatever else is set", () => {
  for (const name of [
    "openai-compatible",
    "groq",
    "grok",
    "mistral",
    "opena",
    "anthropicc",
    "azure",
  ]) {
    assert.equal(
      resolve({
        MODEL_PROVIDER: name,
        ANTHROPIC_API_KEY: KEY,
        OPENAI_API_KEY: KEY,
        MODEL_BASE_URL: "http://x",
      }),
      null,
      name,
    );
  }
});

test("the fake vendor works only in local environments", () => {
  for (const environment of ["development", "local", "test"])
    assert.deepEqual(resolve({ MODEL_PROVIDER: "fake" }, environment), { name: "fake" });
  for (const environment of ["production", "staging", "preview", ""])
    assert.equal(resolve({ MODEL_PROVIDER: "fake" }, environment), null, environment);
});

/* - Which model ------------------------------------------------------------ */

const claude = { name: "claude" } as const;
const openai = { name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: KEY } as const;
const ollama = { name: "ollama", baseUrl: "http://x/v1" } as const;

test("on Claude a feature keeps its own variables, in order, then today's model", () => {
  const names = featureRow("intent_names");
  assert.equal(modelIdFor(names, claude, cfg({})), "claude-sonnet-5-5");
  assert.equal(
    modelIdFor(names, claude, cfg({ TRACE_WORKFLOW_LABEL_MODEL: "claude-haiku-5-5" })),
    "claude-haiku-5-5",
  );
  assert.equal(
    modelIdFor(
      names,
      claude,
      cfg({
        TRACE_WORKFLOW_LABEL_MODEL: "claude-haiku-5-5",
        TOPICS_LABEL_MODEL: "claude-opus-5-5",
        INTENT_ENGINE_NAME_MODEL: "claude-sonnet-5",
      }),
    ),
    "claude-sonnet-5",
  );
  assert.equal(modelIdFor(featureRow("match_quality_analyst"), claude, cfg({})), "claude-opus-5-5");
  assert.equal(modelIdFor(featureRow("eval_gate_judge"), claude, cfg({})), "claude-haiku-5-5");
});

test("a hosted vendor has a model for every tier, so a key is enough", () => {
  for (const vendor of Object.values(VENDORS).filter((v) => v.hosted)) {
    for (const row of FEATURES.filter((r) => r.kind !== "decision")) {
      assert.ok(modelIdFor(row, { name: vendor.name }, cfg({})), `${vendor.name}: ${row.id}`);
    }
  }
});

test("a vendor that serves Claude runs the same model as today", () => {
  for (const name of ["gcp", "bedrock"] as const) {
    for (const row of FEATURES.filter((r) => r.kind !== "decision")) {
      assert.equal(
        modelIdFor(row, { name }, cfg({})),
        modelIdFor(row, claude, cfg({})),
        `${name}: ${row.id}`,
      );
    }
  }
});

test("MODEL is the model of every feature, on every vendor", () => {
  for (const vendor of [claude, openai, ollama, { name: "gcp" }, { name: "bedrock" }] as const) {
    for (const row of FEATURES.filter((r) => r.kind !== "decision"))
      assert.equal(modelIdFor(row, vendor, cfg({ MODEL: "one" })), "one", vendor.name);
  }
});

test("the settings a feature has always read on Claude are ahead of MODEL", () => {
  const analyst = featureRow("match_quality_analyst");
  const env = { MODEL: "one", ANTHROPIC_MODEL: "claude-opus-5" };
  assert.equal(modelIdFor(analyst, claude, cfg(env)), "claude-opus-5");
  assert.equal(modelIdFor(analyst, openai, cfg(env)), "one");
});

test("a feature's size is Ratel's own: MODEL_DEEP, MODEL_STANDARD and MODEL_FAST are not settings", () => {
  const env = { MODEL_DEEP: "x", MODEL_STANDARD: "x", MODEL_FAST: "x" };
  for (const row of FEATURES.filter((r) => r.kind !== "decision")) {
    assert.equal(modelIdFor(row, openai, cfg(env)), modelIdFor(row, openai, cfg({})), row.id);
    assert.equal(modelIdFor(row, ollama, cfg(env)), null, row.id);
  }
});

test("a feature's own variable changes that feature alone, ahead of everything", () => {
  const env = {
    MODEL_FEATURE_EVAL_GATE_JUDGE: "picked",
    EVAL_GATE_JUDGE_MODEL: "claude-haiku-4-5",
    MODEL: "one",
  };
  for (const vendor of [claude, openai, ollama])
    assert.equal(
      modelIdFor(featureRow("eval_gate_judge"), vendor, cfg(env)),
      "picked",
      vendor.name,
    );
  assert.equal(modelIdFor(featureRow("eval_gate_task_judge"), openai, cfg(env)), "one");
});

test("a Claude model named for a feature is not sent to a vendor that has no Claude", () => {
  const analyst = featureRow("match_quality_analyst");
  const env = { ANTHROPIC_MODEL: "claude-opus-5" };
  assert.equal(modelIdFor(analyst, openai, cfg(env)), VENDORS.openai.models?.deep);
  assert.equal(modelIdFor(analyst, { name: "bedrock" }, cfg(env)), "claude-opus-5");
});

test("a self-hosted server has no model until one is named: for every feature, or for one", () => {
  const analyst = featureRow("match_quality_analyst");
  const label = featureRow("workflow_label");
  assert.equal(modelIdFor(analyst, ollama, cfg({})), null);
  const own = { MODEL_FEATURE_MATCH_QUALITY_ANALYST: "qwen-big" };
  assert.equal(modelIdFor(analyst, ollama, cfg(own)), "qwen-big");
  assert.equal(modelIdFor(label, ollama, cfg(own)), null);
  assert.equal(modelIdFor(label, ollama, cfg({ ...own, MODEL: "llama3.3" })), "llama3.3");
  assert.equal(modelIdFor(analyst, ollama, cfg({ ...own, MODEL: "llama3.3" })), "qwen-big");
});

test("the fake vendor names one model", () => {
  assert.equal(
    modelIdFor(featureRow("workflow_label"), { name: "fake" }, cfg({})),
    "fake-model-local",
  );
});

test("MODEL_MAX_OUTPUT_TOKENS is a positive whole number; anything else stops the start", () => {
  const cap = (value?: string) =>
    cfg({ MODEL_MAX_OUTPUT_TOKENS: value }).modelVendor.maxOutputTokens;
  assert.equal(cap(), undefined);
  assert.equal(cap("8192"), 8192);
  for (const value of ["0", "-5", "abc", "12.5"])
    assert.throws(() => cap(value), /MODEL_MAX_OUTPUT_TOKENS/, value);
});

test("the settings need not come from the environment", () => {
  const config = resolveConfig({
    override: {
      modelVendor: { name: "ollama", baseUrl: "http://box:11434", model: "llama3.3" },
    },
  });
  assert.equal(resolveModelVendor(config, "production")?.baseUrl, "http://box:11434/v1");
  assert.equal(modelIdFor(featureRow("workflow_label"), ollama, config), "llama3.3");
});
