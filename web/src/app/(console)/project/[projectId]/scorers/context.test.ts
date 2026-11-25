import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { resetConfigForTests } from "@/config";
import EditScorerPage from "./[scorerId]/edit/page";
import ScorerPage from "./[scorerId]/page";
import { resolveScorersPage, type ScorersPageDeps } from "./context";
import NewScorerPage from "./new/page";
import ScorersPage from "./page";

const scorerParams = () => ({ params: Promise.resolve({ projectId: "p1", scorerId: "s1" }) });
const PAGES = [
  ["Scorers", () => ScorersPage(scorerParams())],
  ["New scorer", () => NewScorerPage(scorerParams())],
  ["Scorer", () => ScorerPage(scorerParams())],
  ["Edit scorer", () => EditScorerPage(scorerParams())],
] as const;
const SWITCHES = ["CONFIG_PATH", "DATABASE_URL"] as const;

test("with a database, the page is the reader's", async () => {
  const deps: ScorersPageDeps = {
    isDbConfigured: () => true,
    requireProjectScope: async () =>
      ({
        project: { id: "p1" },
        organization: { id: "o1" },
        user: { externalId: "u1" },
      }) as Awaited<ReturnType<ScorersPageDeps["requireProjectScope"]>>,
  };
  assert.deepEqual(await resolveScorersPage("p1", deps), { projectId: "p1" });
});

for (const [name, render] of PAGES) {
  test(`${name}: without a database, the page shows the setup notice`, () =>
    withoutDatabase(async () => {
      const page = await render();
      assert.ok(isValidElement(page));
      assert.equal(page.type, DatabaseUnavailable);
    }));
}

/** Runs without a database, whatever the machine's environment. */
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
