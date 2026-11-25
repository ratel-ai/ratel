import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ConfigError, getConfig, resetConfigForTests, resolveConfig } from "@/config";
import { CORE_FLAGS } from "@/lib/contracts/feature-flags";

const dir = mkdtempSync(path.join(tmpdir(), "ratel-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function configFile(name: string, values: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(values));
  return file;
}

function configErrorOf(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the config to fail");
}

test("defaults when nothing is set", () => {
  const config = resolveConfig();
  assert.equal(config.app.composition, "oss");
  assert.equal(config.app.name, "Ratel");
  assert.equal(config.app.baseUrl, "http://localhost:3000");
  assert.equal(config.app.environment, "development");
  assert.equal(config.app.role, "all");
  assert.equal(config.database.url, undefined);
  assert.equal(config.database.poolMax, 10);
  assert.equal(config.database.readTimeoutMs, 15_000);
  assert.equal(config.jobs.runningPerProject, 1);
  assert.equal(config.traceTurns.stepCap, 40);
  assert.equal(config.traceSignals.floors.magnet.minTop3Low, 0.05);
  assert.equal(config.experimentalFeatures, false);
});

test("env only", () => {
  const config = resolveConfig({
    env: {
      DATABASE_URL: "postgres://env@localhost/ratel",
      DATABASE_POOL_MAX: "25",
      APP_ROLE: " Worker ",
      TRACE_SIGNALS_MAGNET_MIN_IMPRESSIONS: "80",
    },
  });
  assert.equal(config.database.url, "postgres://env@localhost/ratel");
  assert.equal(config.database.poolMax, 25);
  assert.equal(config.app.role, "worker");
  assert.equal(config.traceSignals.floors.magnet.minImpressions, 80);
});

test("file only", () => {
  const configPath = configFile("file-only.json", {
    database: { url: "postgres://file@localhost/ratel", poolMax: 4 },
    app: { name: "Ratel Staging" },
    flags: { evalGate: true },
  });
  const config = resolveConfig({ configPath });
  assert.equal(config.database.url, "postgres://file@localhost/ratel");
  assert.equal(config.database.poolMax, 4);
  assert.equal(config.app.name, "Ratel Staging");
  assert.equal(config.flags.evalGate, true);
});

test("CONFIG_PATH in the environment names the file", () => {
  const configPath = configFile("config-path.json", { jobs: { runningPerProject: 3 } });
  assert.equal(resolveConfig({ env: { CONFIG_PATH: configPath } }).jobs.runningPerProject, 3);
});

test("env and file mixed: each setting from wherever it is set", () => {
  const configPath = configFile("mixed.json", {
    database: { poolMax: 4 },
    app: { name: "From file" },
  });
  const config = resolveConfig({
    configPath,
    env: { DATABASE_URL: "postgres://env@localhost/ratel" },
  });
  assert.equal(config.database.url, "postgres://env@localhost/ratel");
  assert.equal(config.database.poolMax, 4);
  assert.equal(config.app.name, "From file");
});

test("precedence: env over file over default", () => {
  const configPath = configFile("precedence.json", {
    database: { poolMax: 4, connectTimeoutMs: 9_000 },
  });
  const config = resolveConfig({ configPath, env: { DATABASE_POOL_MAX: "30" } });
  assert.equal(config.database.poolMax, 30, "env wins over the file");
  assert.equal(config.database.connectTimeoutMs, 9_000, "the file wins over the default");
  assert.equal(config.database.queryTimeoutMs, 120_000, "the default answers last");
});

test("a blank env value reads as unset", () => {
  const config = resolveConfig({
    env: { DATABASE_POOL_MAX: "  ", APP_NAME: "", DATABASE_URL: "" },
  });
  assert.equal(config.database.poolMax, 10);
  assert.equal(config.app.name, "Ratel");
  assert.equal(config.database.url, undefined);
});

test("an invalid number fails with a ConfigError naming the path and the env var", () => {
  const error = configErrorOf(() => resolveConfig({ env: { DATABASE_POOL_MAX: "many" } }));
  assert.equal(error.path, "database.poolMax");
  assert.match(error.message, /database\.poolMax/);
  assert.match(error.message, /DATABASE_POOL_MAX/);
});

test("an invalid value in the file fails too", () => {
  const configPath = configFile("invalid.json", { database: { poolMax: "many" } });
  const error = configErrorOf(() => resolveConfig({ configPath }));
  assert.equal(error.path, "database.poolMax");
  assert.match(error.message, /DATABASE_POOL_MAX/);
});

test("a CONFIG_PATH that names no file fails", () => {
  configErrorOf(() => resolveConfig({ configPath: path.join(dir, "missing.json") }));
});

test("flags are unset by default: the edition decides, else off", () => {
  const { flags } = resolveConfig();
  for (const flag of CORE_FLAGS) assert.equal(flags[flag], undefined, flag);
});

test("a flag reads true, 1, false and 0 in any case, trimmed", () => {
  for (const [raw, expected] of [
    ["true", true],
    [" TRUE ", true],
    ["1", true],
    ["false", false],
    ["False", false],
    ["0", false],
  ] as const) {
    assert.equal(resolveConfig({ env: { FF_EVAL_GATE: raw } }).flags.evalGate, expected, raw);
  }
});

test("each flag has its own env var and file key", () => {
  const env = {
    FF_EVAL_GATE: "1",
    FF_RANKING_CATALOG_DRIFT: "1",
    FF_MCP_APPS: "1",
    FF_AGENTS_PAGES: "1",
    FF_TOOL_RUN_INSIGHTS: "1",
    FF_FOCUSED_CONSOLE: "1",
    FF_SANDBOXES: "1",
  };
  const fromEnv = resolveConfig({ env }).flags;
  const fromFile = resolveConfig({
    configPath: configFile("flags.json", {
      flags: Object.fromEntries(CORE_FLAGS.map((flag) => [flag, false])),
    }),
  }).flags;
  for (const flag of CORE_FLAGS) {
    assert.equal(fromEnv[flag], true, flag);
    assert.equal(fromFile[flag], false, flag);
  }
});

test("any other flag value fails with a clear ConfigError", () => {
  const error = configErrorOf(() => resolveConfig({ env: { FF_MCP_APPS: "yes" } }));
  assert.equal(error.path, "flags.mcpApps");
  assert.match(error.message, /FF_MCP_APPS/);
  assert.match(error.message, /true.*1.*false.*0/);
});

test("RATEL_EXPERIMENTAL_FEATURES is experimentalFeatures", () => {
  assert.equal(
    resolveConfig({ env: { RATEL_EXPERIMENTAL_FEATURES: "true" } }).experimentalFeatures,
    true,
  );
  assert.equal(
    resolveConfig({ env: { RATEL_EXPERIMENTAL_FEATURES: "0" } }).experimentalFeatures,
    false,
  );
  const configPath = configFile("experimental.json", { experimentalFeatures: true });
  assert.equal(resolveConfig({ configPath }).experimentalFeatures, true);
  configErrorOf(() => resolveConfig({ env: { RATEL_EXPERIMENTAL_FEATURES: "on" } }));
});

test("a secret still at the Terraform placeholder reads as unset", () => {
  const config = resolveConfig({
    env: { ANTHROPIC_API_KEY: "REPLACE_ME", OPENAI_API_KEY: " sk-1 " },
  });
  assert.equal(config.anthropic.apiKey, undefined);
  assert.equal(config.openai.apiKey, "sk-1");
});

test("the Bedrock bearer token comes from env or file; blank and the placeholder read as unset", () => {
  assert.equal(
    resolveConfig({ env: { AWS_BEARER_TOKEN_BEDROCK: " tok " } }).anthropic.bedrockBearerToken,
    "tok",
  );
  const configPath = configFile("bedrock-token.json", {
    anthropic: { bedrockBearerToken: "from-file" },
  });
  assert.equal(resolveConfig({ configPath }).anthropic.bedrockBearerToken, "from-file");
  for (const raw of ["", "  ", "REPLACE_ME"]) {
    const { anthropic } = resolveConfig({ env: { AWS_BEARER_TOKEN_BEDROCK: raw } });
    assert.equal(anthropic.bedrockBearerToken, undefined, JSON.stringify(raw));
  }
});

test("override sets values over every source, for tests", () => {
  const config = resolveConfig({
    env: { FF_EVAL_GATE: "0" },
    override: { flags: { evalGate: true } },
  });
  assert.equal(config.flags.evalGate, true);
});

test("getConfig reads the process environment once, until a test resets it", () => {
  const saved = process.env.DATABASE_POOL_MAX;
  try {
    process.env.DATABASE_POOL_MAX = "17";
    resetConfigForTests();
    assert.equal(getConfig().database.poolMax, 17);
    process.env.DATABASE_POOL_MAX = "18";
    assert.equal(getConfig().database.poolMax, 17, "memoized");
    resetConfigForTests();
    assert.equal(getConfig().database.poolMax, 18);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = saved;
    resetConfigForTests();
  }
});
