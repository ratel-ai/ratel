import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The cross-tenant Quality list reads every customer's projects. It must stay reachable only from
 * the operator pages, which open it after the edition's `OperatorConsole.authorize`: a second
 * importer would be a route that lists every tenant without that gate.
 */
const WEB = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // `app/(ee)` holds the edition's route stubs when ee is linked; they cannot import the core.
      if (entry.name === "node_modules" || entry.name === "(ee)") return [];
      return sources(full);
    }
    if (!/\.(ts|tsx|mts)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [full];
  });
}

const tree = ["app", "components", "lib"].flatMap((dir) => sources(join(WEB, dir)));
const mentioning = (needle: RegExp) =>
  tree
    .filter((file) => needle.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB, file))
    .sort();

test("only the operator pages' loader reads the cross-tenant Quality list", () => {
  assert.deepEqual(mentioning(/\blistQualityProjectSummaries\b/), [
    "lib/synthesis/quality/service.ts",
    "lib/views/quality/operator-pages.ts",
  ]);
});

test("only the two operator Quality routes import that loader", () => {
  assert.deepEqual(mentioning(/operator-pages["']/), [
    "app/(operator)/admin/quality/[projectId]/page.tsx",
    "app/(operator)/admin/quality/page.tsx",
  ]);
});
