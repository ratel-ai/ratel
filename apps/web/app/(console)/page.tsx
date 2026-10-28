import { Badge } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { getRuntime } from "@/lib/runtime";

// The composition is selected at boot, so the console must not be prerendered:
// a static page would bake one edition into the build and ignore the runtime value.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const runtime = await getRuntime();
  const principal = runtime.principal;

  return (
    <Page>
      <PageHeader title={runtime.edition} description={principal?.name ?? undefined} />
      <PageBody>
        <Section title="Signed in" description={principal?.email ?? "No principal"}>
          {runtime.planId ? <Badge tone="accent">{runtime.planId}</Badge> : null}
        </Section>
      </PageBody>
    </Page>
  );
}
