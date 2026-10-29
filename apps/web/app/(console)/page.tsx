import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { redirect } from "next/navigation";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { entryHref } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";
import { isDbConfigured } from "@/lib/platform/db/client";

// The composition is selected at boot, so the console must not be prerendered:
// a static page would bake one edition into the build and ignore the runtime value.
export const dynamic = "force-dynamic";

/** The console entry: the first project, or the first-run state when there is none. */
export default async function HomePage() {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Ratel">
        Set <code>DATABASE_URL</code> and restart; projects appear here once the database is
        reachable.
      </DatabaseUnavailable>
    );
  }
  const scope = await getConsoleScope();
  const href = entryHref(scope?.projects ?? []);
  if (href) redirect(href);
  return (
    <Page>
      <PageHeader title="Ratel" />
      <PageBody>
        <EmptyState
          emblem
          title="No project yet"
          description="A project holds the traces, logs and catalog an agent sends. This organization has none."
          secondary={
            <span className="text-sm text-fg-muted">
              Locally, <code>pnpm --filter @ratel/platform seed</code> creates a demo project.
            </span>
          }
        />
      </PageBody>
    </Page>
  );
}
