import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { resetConfigForTests } from "@/config";
import type { FeaturePageDeps } from "../feature-page";
import { resolveExplorePage } from "./context";
import ExplorePage from "./page";

const params = () => ({
  params: Promise.resolve({ projectId: "p1" }),
  searchParams: Promise.resolve({}),
});
const PAGES = [["Explore", () => ExplorePage(params())]] as const;
const SWITCHES = ["CONFIG_PATH", "RATEL_EXPERIMENTAL_FEATURES", "DATABASE_URL"];

test("with a database, the page is the reader's project", async () => {
  const deps: FeaturePageDeps = {
    isDbConfigured: () => true,
    requireProjectScope: async () =>
      ({
        project: { id: "p1" },
        organization: { id: "o1" },
        user: { externalId: "u1" },
      }) as Awaited<ReturnType<FeaturePageDeps["requireProjectScope"]>>,
  };
  assert.deepEqual(await resolveExplorePage("p1", deps), {
    projectId: "p1",
    organizationId: "o1",
    actor: "u1",
  });
});

for (const [name, render] of PAGES) {
  test(`${name}: no database, the page shows the setup notice`, () =>
    withoutDatabase(async () => {
      const page = await render();
      assert.ok(isValidElement(page));
      assert.equal(page.type, DatabaseUnavailable);
    }));
}

/** Runs with no database, whatever the machine's environment. */
async function withoutDatabase(run: () => Promise<void>): Promise<void> {
  const saved = SWITCHES.map((name) => [name, process.env[name]] as const);
  for (const name of SWITCHES) delete process.env[name];
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
