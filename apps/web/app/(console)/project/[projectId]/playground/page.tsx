import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { SearchCheck } from "lucide-react";
import Link from "next/link";
import { projectRoot } from "@/lib/console/navigation";

export const metadata = { title: "Test a search" };

/** Where the Catalog's "Test a search" links land until the Playground is built on the design system. */
export default async function TestSearchPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <Page>
      <PageHeader title="Test a search" />
      <PageBody>
        <EmptyState
          icon={SearchCheck}
          title="Testing a search is not available yet"
          description="The Catalog shows every tool and skill and the description each one is found by."
          action={
            <Link
              href={`${projectRoot(projectId)}/catalogs`}
              className={buttonVariants({ variant: "secondary" })}
            >
              Back to the catalog
            </Link>
          }
        />
      </PageBody>
    </Page>
  );
}
