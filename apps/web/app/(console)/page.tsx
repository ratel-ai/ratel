import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { WorkspaceCard } from "@/components/workspace-card";
import { getRuntime } from "@/lib/runtime";

// The composition is selected at boot, so the console must not be prerendered:
// a static page would bake one edition into the build and ignore the runtime value.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const runtime = await getRuntime();

  return (
    <Page>
      <PageHeader title={runtime.edition} description={runtime.principal?.label} />
      <PageBody>
        <WorkspaceCard workspace={runtime.workspace} workspaces={runtime.workspaces} />
      </PageBody>
    </Page>
  );
}
