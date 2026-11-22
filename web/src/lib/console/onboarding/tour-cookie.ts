import {
  isOnboardingTourStatus,
  type OnboardingTourStatus,
} from "@/lib/console/onboarding/tour-state";

/**
 * Where this edition remembers how a person left the guided tour. Upstream keeps it on
 * `users.onboarding_tour_status`; the users table is the private edition's (ADR-0030), so here it
 * is a cookie: per browser, not per account. Read with upstream's `shouldOfferTour`, which treats
 * anything it does not recognise as "never finished" and offers the tour again.
 */
export const TOUR_STATUS_COOKIE = "ratel_tour_status";

export function tourStatusCookie(status: OnboardingTourStatus, secure: boolean) {
  if (!isOnboardingTourStatus(status)) throw new TypeError("unknown onboarding tour status");
  return {
    name: TOUR_STATUS_COOKIE,
    value: status,
    options: {
      httpOnly: true,
      maxAge: 31_536_000,
      path: "/",
      sameSite: "lax" as const,
      secure,
    },
  };
}

export type RecordTourStatusDeps = {
  /** The cookie's value on this request. */
  current(): string | null | undefined;
  write(cookie: ReturnType<typeof tourStatusCookie>): void;
  secure: boolean;
};

/**
 * Writes the status when it differs from the stored one; says whether it wrote. A cookie set in
 * a server action makes Next render the page again, so a re-run that ends the same way writes
 * nothing.
 */
export function recordTourStatus(status: unknown, deps: RecordTourStatusDeps): boolean {
  if (!isOnboardingTourStatus(status)) return false;
  if (deps.current() === status) return false;
  deps.write(tourStatusCookie(status, deps.secure));
  return true;
}
