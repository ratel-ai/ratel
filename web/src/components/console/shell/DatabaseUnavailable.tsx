import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import type { ReactNode } from "react";

/**
 * A deployment without a database (a fresh local setup): the page keeps its
 * title and says, in place of its data, that the data comes once setup finishes.
 */
export function DatabaseUnavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page>
      <PageHeader title={title} />
      <PageBody>
        <Callout title="No database connected yet">{children}</Callout>
      </PageBody>
    </Page>
  );
}
