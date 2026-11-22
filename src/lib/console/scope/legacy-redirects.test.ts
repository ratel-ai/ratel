import assert from "node:assert/strict";
import { test } from "node:test";
import {
  iaV2CandidatePath,
  legacyRouteDestination,
  legacyRouteRedirect,
} from "@/lib/console/scope/legacy-redirects";
import { sentinelDestination } from "@/lib/console/scope/sentinel";

const COOKIE_PROJECT_ID = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
const USER_ID = "11111111-1111-4111-8111-111111111111";

test("IA v2 pathname gate selects only scoped and legacy redirect routes", () => {
  const candidates = [
    "/dashboard",
    "/dashboard/",
    "/dashboard/service-health",
    "/traces",
    "/traces/events",
    "/explore",
    "/experiments/run-1",
    "/embeddings",
    "/settings",
    "/members",
    "/billing",
    "/project/a7654cd9-a761-4bb1-8606-cb107e4c8d22/traces",
  ];
  const nonCandidates = [
    "/",
    "/api/traces",
    "/trpc/projects",
    "/organizations",
    "/org/acme-labs",
    "/invite/invitation-token",
    "/projector",
  ];

  assert.ok(candidates.every(iaV2CandidatePath));
  assert.ok(nonCandidates.every((pathname) => !iaV2CandidatePath(pathname)));
});

test("legacy redirects are permanent and preserve query parameters", async () => {
  const redirect = await legacyRouteRedirect(
    new URL("https://cloud.ratel.sh/traces/events?project=support-agent&range=custom&tag=a%2Fb"),
    async () => "a7654cd9-a761-4bb1-8606-cb107e4c8d22",
  );

  assert.deepEqual(redirect, {
    destination: "/project/a7654cd9-a761-4bb1-8606-cb107e4c8d22/traces/logs?range=custom&tag=a%2Fb",
    status: 308,
  });
});

test("legacy dashboard project slug maps to its scoped project UUID", async () => {
  const projectId = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";

  const destination = await legacyRouteDestination(
    new URL("https://cloud.ratel.sh/dashboard?project=support-agent&range=7d"),
    async (slug) => (slug === "support-agent" ? projectId : null),
  );

  assert.equal(destination, `/project/${projectId}/dashboards?range=7d`);
});

test("legacy dashboard trailing slashes and subpaths map to scoped dashboards", async () => {
  const destinations = await Promise.all(
    ["/dashboard/", "/dashboard/service-health?range=7d"].map((path) =>
      legacyRouteDestination(new URL(`https://cloud.ratel.sh${path}`), async () => null),
    ),
  );

  assert.deepEqual(destinations, [
    "/project/_/dashboards/",
    "/project/_/dashboards/service-health?range=7d",
  ]);
});

test("dashboard, settings, and direct sentinel entries resume the last cookie project", async () => {
  const legacyDestinations = await Promise.all(
    ["/dashboard", "/settings"].map((path) =>
      legacyRouteDestination(new URL(`https://cloud.ratel.sh${path}`), async () => null),
    ),
  );
  assert.deepEqual(legacyDestinations, ["/project/_/dashboards", "/project/_/settings"]);

  const deps = {
    getLastProjectId: async () => {
      assert.fail("DB pointer must not be read after a valid cookie");
    },
    resolveProjectScope: async (projectId: string) =>
      projectId === COOKIE_PROJECT_ID ? { projectId } : null,
  };
  assert.deepEqual(
    await Promise.all(
      [["dashboards"], ["settings"], ["traces"]].map((path) =>
        sentinelDestination(COOKIE_PROJECT_ID, path, {}, USER_ID, deps),
      ),
    ),
    [
      `/project/${COOKIE_PROJECT_ID}/dashboards`,
      `/project/${COOKIE_PROJECT_ID}/settings`,
      `/project/${COOKIE_PROJECT_ID}/traces`,
    ],
  );
});

test("legacy project surfaces map to their renamed scoped routes", async () => {
  const destinations = await Promise.all(
    [
      "/traces?range=30d&cursor=next",
      "/traces/abc123?range=7d",
      "/traces/compare?a=left&b=right",
      "/traces/events?eventName=completed",
      "/explore?sort=name",
      "/explore?tab=intents&intentsPage=2",
      "/explore?tab=suggestions&sstatus=approved",
      "/experiments?range=30d",
      "/experiments/run-1?range=custom&from=2026-08-01&to=2026-08-08",
      "/embeddings?credit=success",
      "/settings",
    ].map((path) =>
      legacyRouteDestination(new URL(`https://cloud.ratel.sh${path}`), async () => null),
    ),
  );

  assert.deepEqual(destinations, [
    "/project/_/traces?range=30d&cursor=next",
    "/project/_/traces/abc123?range=7d",
    "/project/_/traces/compare?a=left&b=right",
    "/project/_/traces/logs?eventName=completed",
    "/project/_/catalogs/skills?sort=name",
    "/project/_/improvement",
    "/project/_/improvement",
    "/project/_/calibration?range=30d",
    "/project/_/calibration/run-1?range=custom&from=2026-08-01&to=2026-08-08",
    "/project/_/models/embeddings?credit=success",
    "/project/_/settings",
  ]);
});

test("legacy project queries resolve directly to the scoped project UUID", async () => {
  const projectId = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
  const destination = await legacyRouteDestination(
    new URL(
      "https://cloud.ratel.sh/traces/events?project=support-agent&range=custom&from=2026-08-01&to=2026-08-08&cursor=next",
    ),
    async (slug) => (slug === "support-agent" ? projectId : null),
  );

  assert.equal(
    destination,
    `/project/${projectId}/traces/logs?range=custom&from=2026-08-01&to=2026-08-08&cursor=next`,
  );
});

test("legacy route destination does not mutate the caller's URL", async () => {
  const url = new URL("https://cloud.ratel.sh/traces?project=support-agent&range=30d");
  const original = url.href;

  await legacyRouteDestination(url, async () => null);

  assert.equal(url.href, original);
});

test("legacy organization surfaces resolve beneath the active organization", async () => {
  const destinations = await Promise.all(
    ["/members?invite=pending", "/billing?checkout=success"].map((path) =>
      legacyRouteDestination(
        new URL(`https://cloud.ratel.sh${path}`),
        async () => null,
        async () => "acme-labs",
      ),
    ),
  );

  assert.deepEqual(destinations, [
    "/org/acme-labs/team?invite=pending",
    "/org/acme-labs/billing?checkout=success",
  ]);
});

test("unmoved and unresolved organization routes keep legacy behavior", async () => {
  const destinations = await Promise.all(
    ["/organizations", "/members"].map((path) =>
      legacyRouteDestination(
        new URL(`https://cloud.ratel.sh${path}`),
        async () => null,
        async () => null,
      ),
    ),
  );

  assert.deepEqual(destinations, [null, null]);
});
