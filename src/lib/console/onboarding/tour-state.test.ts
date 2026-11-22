import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isOnboardingTourStatus,
  parseOnboardingTourStatus,
  shouldOfferTour,
} from "@/lib/console/onboarding/tour-state";

test("only the two declared statuses are recognized", () => {
  assert.equal(isOnboardingTourStatus("completed"), true);
  assert.equal(isOnboardingTourStatus("skipped"), true);

  assert.equal(isOnboardingTourStatus("dismissed"), false);
  assert.equal(isOnboardingTourStatus("COMPLETED"), false);
  assert.equal(isOnboardingTourStatus(""), false);
  assert.equal(isOnboardingTourStatus(null), false);
  assert.equal(isOnboardingTourStatus(undefined), false);
  assert.equal(isOnboardingTourStatus(1), false);
  assert.equal(isOnboardingTourStatus({ status: "completed" }), false);
});

test("parsing narrows a stored value or reports it as unfinished", () => {
  assert.equal(parseOnboardingTourStatus("skipped"), "skipped");
  assert.equal(parseOnboardingTourStatus("completed"), "completed");
  assert.equal(parseOnboardingTourStatus("something-else"), null);
  assert.equal(parseOnboardingTourStatus(null), null);
});

// The column has no CHECK constraint, so an unrecognized value is reachable
// via an older release, a hand-run UPDATE, or a rolled-back status. Offering the
// tour again is recoverable; withholding it forever is not.
test("an unrecognized stored status offers the tour again", () => {
  assert.equal(shouldOfferTour(null), true, "never finished");
  assert.equal(shouldOfferTour(undefined), true);
  assert.equal(shouldOfferTour(""), true);
  assert.equal(shouldOfferTour("in_progress"), true, "unknown fails open");

  assert.equal(shouldOfferTour("completed"), false);
  assert.equal(shouldOfferTour("skipped"), false, "dismissing the tour answers the question too");
});
