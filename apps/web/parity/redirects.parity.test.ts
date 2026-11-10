import { legacyRouteRedirect } from "@/lib/console/scope/legacy-redirects";
import { DASHBOARD_REQUEST, LEGACY_ADDRESSES, PROJECT_ID } from "./inputs";
import { control, parity } from "./ledger";
import { golden, same, thrownRedirect } from "./support";

// Item 19: two old addresses. Cloud's proxy answers `/dashboard` with the shared legacy rule; here
// a route does. The pages are called as Next calls them and their redirect is read off the throw.

type Redirect = { destination: string; status: number } | null;
const cloud = golden<{
  table: Record<string, Redirect>;
  dashboard: Redirect;
  improvementIntents: Redirect;
}>("redirects");
const none = async () => null;

control("the shared legacy rule sends every old address where Cloud sends it", async () => {
  const table: Record<string, Redirect> = {};
  for (const address of LEGACY_ADDRESSES) {
    table[address] = await legacyRouteRedirect(
      new URL(address, "https://console.example"),
      none,
      none,
    );
  }
  same(table, cloud.table);
});

parity(19, "/dashboard redirects permanently, honours ?project= and keeps the query", async () => {
  // No database: no project slug resolves, which is the input Cloud's rule was given.
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { default: DashboardPage } = (await import("@/app/(console)/dashboard/page")) as {
      default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
    };
    const redirect = await thrownRedirect(() =>
      DashboardPage({ searchParams: Promise.resolve({ ...DASHBOARD_REQUEST }) }),
    );
    same(redirect, cloud.dashboard);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

parity(19, "/project/<id>/improvement/intents lands where Cloud's lands", async () => {
  const { default: IntentExtractionPage } = await import(
    "@/app/(console)/project/[projectId]/improvement/intents/page"
  );
  const redirect = await thrownRedirect(() =>
    IntentExtractionPage({ params: Promise.resolve({ projectId: PROJECT_ID }) }),
  );
  same(redirect, cloud.improvementIntents);
});
