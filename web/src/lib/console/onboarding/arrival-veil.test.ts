import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARRIVAL_MAX_WAIT_MS,
  type ArrivalState,
  shouldLift,
} from "@/lib/console/onboarding/arrival-veil";

const ready: ArrivalState = {
  pathname: "/project/p1",
  target: "/project/p1",
  hasMain: true,
  busy: false,
  waited: 200,
};

test("shouldLift once the dashboard has its content", () => {
  assert.equal(shouldLift(ready), true);
});

test("shouldLift holds while the route has not changed yet", () => {
  assert.equal(shouldLift({ ...ready, pathname: "/onboarding" }), false);
});

test("shouldLift holds over the shell skeleton and the page skeleton", () => {
  assert.equal(shouldLift({ ...ready, hasMain: false }), false);
  assert.equal(shouldLift({ ...ready, busy: true }), false);
});

test("shouldLift gives up waiting, so the veil never stays up", () => {
  assert.equal(
    shouldLift({
      ...ready,
      pathname: "/elsewhere",
      hasMain: false,
      busy: true,
      waited: ARRIVAL_MAX_WAIT_MS,
    }),
    true,
  );
});
