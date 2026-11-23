import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectImports, walk } from "../../../../scripts/check-ee-boundary.mjs";

/**
 * The ledger and the readings are pure core: data in, derived rows out. Nothing under them
 * may import the web framework, a React tree, a page, or a layer above them (views, console,
 * synthesis, mcp). `check-layers` enforces the layer rule for `@/lib` imports; this test adds
 * the framework rule and keeps the two readable in one place. Tests are exempt: they may
 * stub whatever they like.
 */

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["ledger", "readings"];
const FORBIDDEN = [
  /^next(\/|$)/,
  /^react(-dom)?(\/|$)/,
  /^@\/components(\/|$)/,
  /^@\/app(\/|$)/,
  /^@\/lib\/(views|console|synthesis|mcp)(\/|$)/,
];

test("the ledger and the readings import no framework, page or higher layer", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    walk(join(LIB, root), (file: string) => {
      if (/\.test\.tsx?$/.test(file)) return;
      for (const { specifier, line } of collectImports(file)) {
        if (FORBIDDEN.some((rule) => rule.test(specifier))) {
          offenders.push(`${relative(LIB, file)}:${line} ${specifier}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});
