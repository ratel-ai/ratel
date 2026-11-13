import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition";
import { entryHref, projectRoot } from "@/lib/console/navigation";
import { LAST_PROJECT_COOKIE } from "@/lib/console/scope/cookie";
import { resolveLastProjectId } from "@/lib/console/scope/landing";
import { getConsoleScope } from "@/lib/console/shell-data";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";

// The composition is selected at boot, so the console must not be prerendered:
// a static page would bake one edition into the build and ignore the runtime value.
export const dynamic = "force-dynamic";

/**
 * The console entry: the project the reader was last in (the same resolution as `/project/_`:
 * the cookie when it names a live project, else the first project), else onboarding. An edition
 * may replace it.
 */
export default async function HomePage() {
  const RootPage = (await composition.ui?.())?.RootPage;
  if (RootPage) return <RootPage />;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Ratel">
        Set <code>DATABASE_URL</code> and restart; projects appear here once the database is
        reachable.
      </DatabaseUnavailable>
    );
  }
  // The scope first: an empty organization gets its sample project there.
  const scope = await getConsoleScope();
  const [cookieStore, context] = await Promise.all([cookies(), getSessionContext()]);
  const lastProjectId = context
    ? await resolveLastProjectId(context.user.id, cookieStore.get(LAST_PROJECT_COOKIE)?.value)
    : null;
  const href = lastProjectId
    ? projectRoot(lastProjectId)
    : entryHref(scope?.projects ?? [], scope?.organizationSlug);
  if (href) redirect(href);
  return (
    <Page>
      <PageHeader title="Ratel" />
      <PageBody>
        <EmptyState
          emblem
          title="No session"
          description="The console could not resolve who is signed in, so it has no organization to show."
        />
      </PageBody>
    </Page>
  );
}
