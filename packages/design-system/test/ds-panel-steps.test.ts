import assert from "node:assert/strict";
import { test } from "node:test";
import { canStep, STEP_INTERVAL_MS } from "../src/components/peek";

test("j and k step once per press: never on key repeat, never faster than the interval", () => {
  assert.equal(canStep({ repeat: false, timeStamp: 1000 }, null), true, "the first press steps");
  assert.equal(
    canStep({ repeat: true, timeStamp: 5000 }, 1000),
    false,
    "a held key repeats without stepping",
  );
  assert.equal(
    canStep({ repeat: false, timeStamp: 1000 + STEP_INTERVAL_MS - 1 }, 1000),
    false,
    "a second press too soon waits",
  );
  assert.equal(canStep({ repeat: false, timeStamp: 1000 + STEP_INTERVAL_MS }, 1000), true);
  assert.equal(
    canStep({ repeat: false, timeStamp: 1010 }, 1000, 5),
    true,
    "the interval can be shorter",
  );
});
