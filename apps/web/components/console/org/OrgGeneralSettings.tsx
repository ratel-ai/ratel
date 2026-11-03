import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { notFound } from "next/navigation";
import { getSessionContext } from "@/lib/platform/session";

/** Organization settings > General: the name and the address, read-only (the edition owns them). */
export async function OrgGeneralSettings({ slug }: { slug: string }) {
  const context = await getSessionContext();
  if (!context || context.organization.slug !== slug) notFound();
  const { organization } = context;
  return (
    <PageBody className="*:min-w-0">
      <Section title="Organization">
        <dl className="grid max-w-md grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
          <dt className="text-fg-subtle">Name</dt>
          <dd className="min-w-0 truncate text-fg">{organization.name}</dd>
          <dt className="text-fg-subtle">Address</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5 text-fg">
            /org/{organization.slug}
          </dd>
        </dl>
      </Section>
    </PageBody>
  );
}
