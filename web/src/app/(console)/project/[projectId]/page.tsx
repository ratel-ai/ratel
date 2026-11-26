import { cookies } from "next/headers";
import { FocusedOverviewPage } from "@/components/console/home/focused/FocusedOverviewPage";
import { OverviewPage } from "@/components/console/home/OverviewPage";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition/ports";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { TOUR_STATUS_COOKIE } from "@/lib/console/onboarding/tour-cookie";
import { shouldOfferTour } from "@/lib/console/onboarding/tour-state";
import { readTourStatus } from "@/lib/console/onboarding/tour-status";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { dbConfigured } from "@/lib/platform/db/request";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";

export const metadata = { title: "Project home" };

/**
 * A project's home: the Overview; with `focusedConsole`, its recap (`FocusedOverviewPage`).
 *
 * Owned (ADR-0004): the project comes from the console scope (the session's
 * organization, a 404 otherwise). How a person left the guided tour is the
 * edition's to keep (`SessionPort.tourStatus`; upstream reads the user row), or
 * a cookie without one.
 */
export default async function ProjectHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await dbConfigured())) {
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
  // Inside an admin support session the operator came to look at the data,
  // not to be onboarded: no auto-start, and finishing records nothing.
  const cookieStore = await cookies();
  const tourStatus = await readTourStatus({
    edition: composition.session.tourStatus,
    cookie: () => cookieStore.get(TOUR_STATUS_COOKIE)?.value,
  });
  const inSupportSession = await isRestrictedBySupportSession();
  const { range, peek } = await searchParams;
  const overview = {
    project,
    organization,
    range,
    inSupportSession,
  };
  const offerTour = !inSupportSession && shouldOfferTour(tourStatus);
  return (await focusedConsoleEnabled(organization)) ? (
    <FocusedOverviewPage {...overview} offerTour={offerTour} peek={peek} />
  ) : (
    <OverviewPage {...overview} offerTour={offerTour} />
  );
}
