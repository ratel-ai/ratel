import { notFound, permanentRedirect } from "next/navigation";
import { composition } from "@/lib/composition";
import { legacyRouteHref } from "@/lib/console/scope/legacy-route";
import type { RouteSearchParams } from "@/lib/console/scope/sentinel";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/**
 * `/billing`, now the organization's. Owned (ADR-0004): upstream's proxy redirects it; here the
 * route does. Billing is the edition's page, so without it the old address stays a 404.
 */
export default async function LegacyBillingPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  if (!(await composition.ui?.())?.OrganizationBillingPage) notFound();
  const href = await legacyRouteHref("/billing", await searchParams, await getConsoleScope());
  if (!href) notFound();
  permanentRedirect(href);
}
