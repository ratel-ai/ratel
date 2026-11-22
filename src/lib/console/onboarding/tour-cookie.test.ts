import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordTourStatus,
  TOUR_STATUS_COOKIE,
  tourStatusCookie,
} from "@/lib/console/onboarding/tour-cookie";
import { shouldOfferTour } from "@/lib/console/onboarding/tour-state";

test("the tour status cookie is durable, site-wide and not readable by scripts", () => {
  assert.deepEqual(tourStatusCookie("completed", true), {
    name: TOUR_STATUS_COOKIE,
    value: "completed",
    options: { httpOnly: true, maxAge: 31_536_000, path: "/", sameSite: "lax", secure: true },
  });
  assert.equal(tourStatusCookie("skipped", false).options.secure, false);
  assert.throws(() => tourStatusCookie("later" as "skipped", false), TypeError);
});

test("finishing or skipping is remembered: the stored value stops the offer", () => {
  let stored: string | undefined;
  const deps = {
    current: () => stored,
    write: (cookie: ReturnType<typeof tourStatusCookie>) => {
      stored = cookie.value;
    },
    secure: false,
  };
  assert.equal(shouldOfferTour(stored), true, "a first visit is offered the tour");
  assert.equal(recordTourStatus("skipped", deps), true);
  assert.equal(stored, "skipped");
  assert.equal(shouldOfferTour(stored), false);
  // A re-run that ends the same way writes nothing; ending another way is recorded.
  assert.equal(recordTourStatus("skipped", deps), false);
  assert.equal(recordTourStatus("completed", deps), true);
  assert.equal(stored, "completed");
  assert.equal(shouldOfferTour(stored), false);
});

test("a value the browser made up is neither stored nor trusted", () => {
  let wrote = false;
  const deps = {
    current: () => undefined,
    write: () => {
      wrote = true;
    },
    secure: false,
  };
  assert.equal(recordTourStatus("done", deps), false);
  assert.equal(recordTourStatus(null, deps), false);
  assert.equal(wrote, false);
  assert.equal(shouldOfferTour("done"), true, "an unknown stored value offers the tour again");
});
