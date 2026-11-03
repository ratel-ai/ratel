import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { organizationRoot } from "@/lib/console/navigation";
import { APP_NAME } from "@/lib/platform/app-config";
import { billingSelfServe, checkOrganizationDeletion } from "@/lib/platform/entitlements";
import { getSessionContext } from "@/lib/platform/session";
import { DeleteOrganization } from "./DeleteOrganization";

/**
 * Organization settings > Danger zone: deleting the
 * organization, admins only. The same refusals as the action: a paid
 * organization cancels its subscription first (the entitlements port's
 * answer), and a support session never deletes.
 */
export async function OrgDangerSettings({ slug }: { slug: string }) {
  const context = await getSessionContext();
  if (!context || context.organization.slug !== slug) notFound();
  const { organization } = context;
  if (context.role !== "admin") {
    return (
      <PageBody className="*:min-w-0">
        <EmptyState
          icon={ShieldAlert}
          title="Only admins can delete an organization"
          description="Ask an admin of this organization if it should go."
        />
      </PageBody>
    );
  }
  const inSupportSession = (await composition.session.actingAs()) !== null;
  const billingEnabled = billingSelfServe(organization);
  const deletion = checkOrganizationDeletion(organization);
  const blockedReason = inSupportSession ? (
    "Not available during an admin support session."
  ) : !deletion.ok ? (
    <>
      {deletion.message}{" "}
      {billingEnabled ? (
        <Link
          href={`${organizationRoot(organization.slug)}/billing`}
          className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-muted"
        >
          Go to Billing
        </Link>
      ) : null}
    </>
  ) : null;

  return (
    <PageBody className="*:min-w-0">
      <Section
        title="Delete organization"
        description={`${APP_NAME} then starts over with an empty organization, as on first run.`}
      >
        <DeleteOrganization
          organizationId={organization.id}
          organizationName={organization.name}
          blockedReason={blockedReason}
        />
      </Section>
    </PageBody>
  );
}
