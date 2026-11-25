import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import type { ReactNode } from "react";
import { alertsHref } from "@/lib/views/alerts/links";

export function NewAlertFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Alerts", href: alertsHref(projectId) }]}
        title="New alert"
        description="A metric, a threshold, and a history of each time it is crossed."
      />
      <PageBody>{children}</PageBody>
    </Page>
  );
}
