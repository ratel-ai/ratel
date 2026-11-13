import { cookies } from "next/headers";
import { OverviewPage } from "@/components/console/home/OverviewPage";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { TOUR_STATUS_COOKIE } from "@/lib/console/onboarding/tour-cookie";
import { shouldOfferTour } from "@/lib/console/onboarding/tour-state";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Project home" };

/**
 * A project's home: the Overview.
 *
 * Owned (ADR-0030): the project comes from the console scope (the session's
 * organization, a 404 otherwise). How a person left the guided tour is read
 * from a cookie (upstream reads the users table, the private edition's); no
 * support session here.
 */
export default async function ProjectHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Overview">
        Project data becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const { projectId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  // Auto-start only for somebody who has never finished it. Everyone else keeps
  // the button and decides for themselves.
  const tourStatus = (await cookies()).get(TOUR_STATUS_COOKIE)?.value;
  return (
    <OverviewPage
      project={project}
      organization={organization}
      range={(await searchParams).range}
      offerTour={shouldOfferTour(tourStatus)}
    />
  );
}
