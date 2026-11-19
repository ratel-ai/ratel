import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/ratel.css", import.meta.url), "utf8");

// Classes an edition's pages use (upstream's `app/globals.css`): defined nowhere, they render
// nothing and fail silently, so pin them here.
for (const name of ["pixel-grid", "pixel-grid-fade", "dialog-enter", "dialog-scrim-enter"]) {
  test(`ratel.css defines .${name}`, () => {
    assert.match(css, new RegExp(`\\.${name}\\s*\\{`));
  });
}

test("the full-strength dot texture .pixel-grid paints is defined", () => {
  assert.match(css, /--pixel-grid-image:/);
});
