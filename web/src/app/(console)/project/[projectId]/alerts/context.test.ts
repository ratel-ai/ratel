import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { resetConfigForTests } from "@/config";
import type { FeaturePageDeps } from "../feature-page";
import NotificationsPage from "../settings/notifications/page";
import AlertPage from "./[ruleId]/page";
import { resolveAlertsPage } from "./context";
import NewAlertPage from "./new/page";
import AlertsPage from "./page";

const is404 = (err: { digest?: string }) => String(err.digest).includes("404");
const params = () => ({
  params: Promise.resolve({ projectId: "p1", ruleId: "r1" }),
  searchParams: Promise.resolve({}),
});
const PAGES = [
  ["Alerts", () => AlertsPage(params())],
  ["New alert", () => NewAlertPage(params())],
  ["Alert", () => AlertPage(params())],
  ["Notifications", () => NotificationsPage(params())],
] as const;
const SWITCHES = [
  "CONFIG_PATH",
  "RATEL_EXPERIMENTAL_FEATURES",
  "DATABASE_URL",
  "FF_CUSTOM_MONITORING",
];

test("the customMonitoring flag decides, for the reader's organization", async () => {
  const asked: unknown[] = [];
  const deps = (on: boolean): FeaturePageDeps => ({
    isDbConfigured: () => true,
    requireProjectScope: async () =>
      ({
        project: { id: "p1" },
        organization: { id: "o1" },
        user: { externalId: "u1" },
      }) as Awaited<ReturnType<FeaturePageDeps["requireProjectScope"]>>,
    featureEnabled: async (...args) => {
      asked.push(args);
      return on;
    },
    flagsPort: () => undefined,
  });
  await assert.rejects(resolveAlertsPage("p1", deps(false)), is404);
  const page = { projectId: "p1", organizationId: "o1", actor: "u1" };
  assert.deepEqual(await resolveAlertsPage("p1", deps(true)), page);
  assert.deepEqual(asked[0], ["customMonitoring", page]);
});

for (const [name, render] of PAGES) {
  test(`${name}: flag off, the page is not found`, () =>
    withFlag(undefined, () => assert.rejects(render(), is404)));

  test(`${name}: flag on and no database, the page shows the setup notice`, () =>
    withFlag("1", async () => {
      const page = await render();
      assert.ok(isValidElement(page));
      assert.equal(page.type, DatabaseUnavailable);
    }));
}

/** Runs with only the customMonitoring flag: no database, whatever the machine's environment. */
async function withFlag(flag: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = SWITCHES.map((name) => [name, process.env[name]] as const);
  for (const name of SWITCHES) delete process.env[name];
  if (flag) process.env.FF_CUSTOM_MONITORING = flag;
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
