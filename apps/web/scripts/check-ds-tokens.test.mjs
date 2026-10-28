import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findDsViolations, scanSource, scanTree } from "./check-ds-tokens.mjs";

describe("findDsViolations", () => {
  it("accepts semantic tokens", () => {
    assert.deepEqual(
      findDsViolations("bg-app text-fg-muted border-line hover:bg-accent text-xs"),
      [],
    );
  });

  it("flags the legacy palette, raw colors and arbitrary colors once each", () => {
    assert.deepEqual(findDsViolations("bg-canvas text-cream"), ["legacy"]);
    assert.deepEqual(findDsViolations("bg-zinc-800 text-white"), ["raw"]);
    assert.deepEqual(findDsViolations("border-[#333] md:text-[rgb(1,2,3)]"), ["raw"]);
    assert.deepEqual(findDsViolations("!bg-forest-600 bg-red-500"), ["legacy", "raw"]);
  });

  it("flags text under 12px and uppercase tracked labels", () => {
    assert.deepEqual(findDsViolations("text-[11px]"), ["small"]);
    assert.deepEqual(findDsViolations("text-[12px]"), []);
    assert.deepEqual(findDsViolations("uppercase tracking-wide text-xs"), ["eyebrow"]);
    assert.deepEqual(findDsViolations("uppercase text-xs"), []);
  });

  it("strips variants and the important mark before matching", () => {
    assert.deepEqual(findDsViolations("data-[state=open]:bg-forest hover:!text-cream-dim"), [
      "legacy",
    ]);
  });
});

describe("scanSource", () => {
  it("reports each literal's violations with its line", () => {
    const src = [
      'const a = cn("bg-app", "text-cream");',
      "const b = `uppercase tracking-wide`;",
      "const c = 'text-fg';",
    ].join("\n");
    assert.deepEqual(scanSource(src), [
      { line: 1, kind: "legacy" },
      { line: 2, kind: "eyebrow" },
    ]);
  });
});

describe("scanTree", () => {
  it("is clean on the current tree", () => {
    assert.deepEqual(scanTree(), []);
  });
});
