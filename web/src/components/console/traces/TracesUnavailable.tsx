import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";

/** No database yet (a fresh local setup): the page says so in place of its data. */
export function TracesUnavailable({ title = "Traces" }: { title?: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <PageBody wide>
        <Callout title="No database connected yet">
          Traces show up here once setup finishes.
        </Callout>
      </PageBody>
    </Page>
  );
}
