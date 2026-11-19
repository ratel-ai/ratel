import { type RecordTourStatusDeps, recordTourStatus } from "@/lib/console/onboarding/tour-cookie";
import type { OnboardingTourStatus } from "@/lib/console/onboarding/tour-state";
import type { TourStatusStore } from "@/lib/contracts/session";

/**
 * Where how a person left the guided tour is kept: with their account when the edition keeps it
 * (`SessionPort.tourStatus`, upstream's `users.onboarding_tour_status`), else in a per-browser
 * cookie (`tour-cookie.ts`).
 */
export type TourStatusDeps = {
  edition?: TourStatusStore;
  cookie: RecordTourStatusDeps;
};

/** The stored status, unvalidated: read it with `shouldOfferTour`. */
export async function readTourStatus({
  edition,
  cookie,
}: {
  edition?: TourStatusStore;
  /** The cookie's value on this request. */
  cookie: RecordTourStatusDeps["current"];
}): Promise<unknown> {
  return edition ? edition.read() : cookie();
}

/** Records a validated status where it is kept. */
export async function saveTourStatus(
  status: OnboardingTourStatus,
  { edition, cookie }: TourStatusDeps,
): Promise<void> {
  if (edition) await edition.write(status);
  else recordTourStatus(status, cookie);
}
