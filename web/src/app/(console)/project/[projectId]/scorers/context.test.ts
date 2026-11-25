import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { resetConfigForTests } from "@/config";
import { type FlagConfig, featureEnabled } from "@/lib/platform/experimental-features";
import EditScorerPage from "./[scorerId]/edit/page";
import ScorerPage from "./[scorerId]/page";
import { resolveScorersPage, type ScorersPageDeps } from "./context";
import NewScorerPage from "./new/page";
import ScorersPage from "./page";

const scope = {
  project: { id: "p1" },
  organization: { id: "o1" },
  user: { externalId: "u1" },
} as Awaited<ReturnType<ScorersPageDeps["requireProjectScope"]>>;
const is404 = (err: { digest?: string }) => String(err.digest).includes("404");
const scorerParams = () => ({ params: Promise.resolve({ projectId: "p1", scorerId: "s1" }) });
const PAGES = [
  ["Scorers", () => ScorersPage(scorerParams())],
  ["New scorer", () => NewScorerPage(scorerParams())],
  ["Scorer", () => ScorerPage(scorerParams())],
  ["Edit scorer", () => EditScorerPage(scorerParams())],
] as const;
const SWITCHES = [
  "CONFIG_PATH",
  "RATEL_EXPERIMENTAL_FEATURES",
  "DATABASE_URL",
  "FF_CUSTOM_MONITORING",
] as const;

test("with a database: flag off, not found; on, the project", async () => {
  const asked: unknown[] = [];
  const deps = (on: boolean): ScorersPageDeps => ({
    ...noDatabase({}, undefined),
    isDbConfigured: () => true,
    requireProjectScope: async () => scope,
    featureEnabled: async (...args) => {
      asked.push(args);
      return on;
    },
  });
  await assert.rejects(resolveScorersPage("p1", deps(false)), is404);
  assert.deepEqual(await resolveScorersPage("p1", deps(true)), { projectId: "p1" });
  assert.deepEqual(asked[0], [
    "customMonitoring",
    { projectId: "p1", organizationId: "o1", actor: "u1" },
  ]);
});

test("without a database, an edition's port is not asked: only a forced value turns the flag on", async () => {
  const port = {
    enabled: async () => {
      throw new Error("the port must not be asked");
    },
  };
  await assert.rejects(resolveScorersPage("p1", noDatabase({}, port)), is404);
  await assert.rejects(
    resolveScorersPage("p1", noDatabase({ customMonitoring: false }, port)),
    is404,
  );
  assert.equal(await resolveScorersPage("p1", noDatabase({ customMonitoring: true }, port)), null);
});

for (const [name, render] of PAGES) {
  test(`${name}: flag off and no database, the page is not found`, () =>
    withEnv({}, () => assert.rejects(render(), is404)));

  test(`${name}: flag on and no database, the page shows the setup notice`, () =>
    withEnv({ FF_CUSTOM_MONITORING: "1" }, async () => {
      const page = await render();
      assert.ok(isValidElement(page));
      assert.equal(page.type, DatabaseUnavailable);
    }));
}

function noDatabase(
  flags: Partial<FlagConfig["flags"]>,
  port: ReturnType<ScorersPageDeps["flagsPort"]>,
): ScorersPageDeps {
  const config = { flags, experimentalFeatures: false } as FlagConfig;
  return {
    isDbConfigured: () => false,
    requireProjectScope: async () => {
      throw new Error("the project must not be read");
    },
    featureEnabled: (flag, subject, deps) => featureEnabled(flag, subject, { ...deps, config }),
    flagsPort: () => port,
  };
}

/** Runs with only these switches set: no database, whatever the machine's environment. */
async function withEnv(
  env: Partial<Record<(typeof SWITCHES)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = SWITCHES.map((name) => [name, process.env[name]] as const);
  for (const name of SWITCHES) delete process.env[name];
  Object.assign(process.env, env);
  resetConfigForTests();
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
  }
}
