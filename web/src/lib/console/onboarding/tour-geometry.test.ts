import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardPosition,
  SPOTLIGHT_PADDING,
  spotlightRect,
} from "@/lib/console/onboarding/tour-geometry";

const VIEWPORT = { width: 1440, height: 900 };
const CARD = { width: 336, height: 200 };

test("the spotlight grows the target by an even margin", () => {
  const hole = spotlightRect({ top: 200, left: 300, width: 400, height: 120 }, VIEWPORT);

  assert.deepEqual(hole, {
    top: 200 - SPOTLIGHT_PADDING,
    left: 300 - SPOTLIGHT_PADDING,
    width: 400 + SPOTLIGHT_PADDING * 2,
    height: 120 + SPOTLIGHT_PADDING * 2,
  });
});

// The sidebar starts at x=0 and the header at y=0. Padding one of those off the
// screen would render a lit region whose visible edge is off-centre.
test("the spotlight never leaves the viewport", () => {
  const hole = spotlightRect({ top: 0, left: 0, width: 232, height: 900 }, VIEWPORT);

  assert.equal(hole.top, 0);
  assert.equal(hole.left, 0);
  assert.equal(hole.height, VIEWPORT.height, "clamped, not overflowing");
});

test("the card sits on the requested side when it fits", () => {
  const hole = spotlightRect({ top: 200, left: 8, width: 216, height: 40 }, VIEWPORT);

  const card = cardPosition(hole, CARD, VIEWPORT, "right");

  assert.equal(card.placement, "right");
  assert.ok(card.left > hole.left + hole.width, "clears the spotlight");
});

test("the card flips to the opposite side rather than overflow", () => {
  // A target hard against the right edge: there is no room on its right.
  const hole = spotlightRect({ top: 200, left: 1200, width: 200, height: 40 }, VIEWPORT);

  const card = cardPosition(hole, CARD, VIEWPORT, "right");

  assert.equal(card.placement, "left");
  assert.ok(card.left + CARD.width <= hole.left, "sits before the spotlight");
});

test("a bottom-placed card flips up when it would run off the fold", () => {
  const hole = spotlightRect({ top: 800, left: 300, width: 500, height: 60 }, VIEWPORT);

  const card = cardPosition(hole, CARD, VIEWPORT, "bottom");

  assert.equal(card.placement, "top");
  assert.ok(card.top + CARD.height <= hole.top);
});

// On a narrow screen NEITHER side fits. Overlapping the spotlight is the lesser
// failure: a card half off-screen is a dead end, because a fixed overlay cannot
// be scrolled to reach it.
test("the card stays fully on screen even when no side fits", () => {
  const narrow = { width: 380, height: 640 };
  const hole = spotlightRect({ top: 100, left: 20, width: 320, height: 48 }, narrow);

  const card = cardPosition(hole, CARD, narrow, "right");

  assert.ok(card.left >= 0, "not off the left edge");
  assert.ok(card.left + CARD.width <= narrow.width, "not off the right edge");
  assert.ok(card.top >= 0);
  assert.ok(card.top + CARD.height <= narrow.height);
});
