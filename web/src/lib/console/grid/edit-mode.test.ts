import assert from "node:assert/strict";
import { test } from "node:test";
import { keyLeavesEditMode, placeWords, takesEscape } from "@/lib/console/grid/edit-mode";

const ESCAPE = {
  key: "Escape",
  continued: false,
  layerOpen: false,
  arranging: false,
  fieldFocused: false,
};

test("Escape leaves edit mode when nothing else answers it", () => {
  assert.equal(keyLeavesEditMode(ESCAPE), true);
  assert.equal(keyLeavesEditMode({ ...ESCAPE, key: "Enter" }), false);
  for (const taken of ["continued", "layerOpen", "arranging", "fieldFocused"] as const)
    assert.equal(keyLeavesEditMode({ ...ESCAPE, [taken]: true }), false, taken);
});

test("a chart's readout in a card and a toast take no Escape; a dialog over the page does", () => {
  const inside = (...around: string[]) => ({
    closest: (selector: string) => (around.includes(selector) ? {} : null),
  });
  assert.equal(takesEscape(inside()), true, "a dialog, a menu or a list of its own");
  assert.equal(takesEscape(inside("[data-grid-body]")), false, "a card's content is inert");
  assert.equal(takesEscape(inside("[role='region'][aria-label='Notifications']")), false);
});

test("a step is announced by where the card is now", () => {
  assert.equal(
    placeWords("Cost", { x: 6, y: 0, w: 4, h: 3 }),
    "Cost: row 1, column 7, 4 wide, 3 high",
  );
});
