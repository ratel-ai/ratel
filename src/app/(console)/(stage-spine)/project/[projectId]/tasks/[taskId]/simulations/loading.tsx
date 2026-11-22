import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";

export default function SimulationsLoading() {
  return (
    <Page>
      <PageHeader title="Simulations" />
      <PageBody>
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </PageBody>
    </Page>
  );
}
