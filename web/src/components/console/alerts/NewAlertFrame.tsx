import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import type { ReactNode } from "react";
import { alertsHref } from "@/lib/views/alerts/links";

export function NewAlertFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Alerts", href: alertsHref(projectId) }]}
        title="New alert"
        description="A message when a metric crosses a threshold, and one when it recovers."
      />
      <PageBody>{children}</PageBody>
    </Page>
  );
}
