/**
 * How a user left the guided tour, and how that value survives the database.
 *
 * `users.onboarding_tour_status` is a plain `text` column with no CHECK
 * constraint, matching how every other small enumeration in this schema is
 * stored (`organizations.plan`, `jobs.status`). A plain column means the
 * READ has to be the guard: anything unrecognized (an older value, a hand-run
 * UPDATE, a future status rolled back) is treated as "never finished", which
 * offers the tour again. Offering a tour twice is a small annoyance; silently
 * trusting an unknown value and withholding it forever is not recoverable by
 * the person it happens to.
 */

export const ONBOARDING_TOUR_STATUSES = ["completed", "skipped"] as const;

export type OnboardingTourStatus = (typeof ONBOARDING_TOUR_STATUSES)[number];

export function isOnboardingTourStatus(value: unknown): value is OnboardingTourStatus {
  return (
    typeof value === "string" && (ONBOARDING_TOUR_STATUSES as readonly string[]).includes(value)
  );
}

/** The stored status, or null when the user has not finished the tour. */
export function parseOnboardingTourStatus(value: unknown): OnboardingTourStatus | null {
  return isOnboardingTourStatus(value) ? value : null;
}

/**
 * Whether the tour should offer itself. True only when the user has never
 * finished it. "Skipped" counts as finished, because a person who dismissed
 * the tour has answered the question.
 */
export function shouldOfferTour(storedStatus: unknown): boolean {
  return parseOnboardingTourStatus(storedStatus) === null;
}
