import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import EvalsProjectLayout from "./layout";

/**
 * RP-151: the Evals pages (the suite, its runs, scorers, a fix's page and its simulations) live in
 * the `(evals)` route group, whose layout decides `FF_EVALS` first. Off, every page is a 404
 * before anything renders, and no Evals route exists outside the group, so the console's routes
 * are what they were before the port.
 */

const SWITCHES = ["FF_EVALS", "RATEL_EXPERIMENTAL_FEATURES"] as const;
const saved: Record<string, string | undefined> = {};
const is404 = (err: { digest?: string }) => String(err.digest).includes("404");
const APP = join(import.meta.dirname, "..", "..", "..", "..");
const GROUP = join(APP, "(console)", "(evals)");

before(() => {
  for (const name of SWITCHES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of SWITCHES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("with FF_EVALS off, the Evals pages answer 404 from their layout", async () => {
  await assert.rejects(
    EvalsProjectLayout({
      children: null,
      params: Promise.resolve({ projectId: "11111111-1111-4111-8111-111111111111" }),
    }),
    is404,
  );
});

test("every Evals page sits under the gated (evals) group, and the group holds nothing else", () => {
  const pages = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return pages(path);
      return name === "page.tsx" ? [relative(APP, path)] : [];
    });
  const gated = pages(GROUP).map((path) => path.replace("(console)/(evals)/", ""));
  assert.deepEqual(gated.sort(), [
    "project/[projectId]/evals/[evalId]/definition/page.tsx",
    "project/[projectId]/evals/[evalId]/page.tsx",
    "project/[projectId]/evals/[evalId]/runs/page.tsx",
    "project/[projectId]/evals/page.tsx",
    "project/[projectId]/evals/runs/[runId]/page.tsx",
    "project/[projectId]/evals/runs/page.tsx",
    "project/[projectId]/evals/scorers/[scorerId]/page.tsx",
    "project/[projectId]/improvement/fixes/[fixId]/page.tsx",
    "project/[projectId]/improvement/fixes/[fixId]/simulations/[runId]/[evalId]/page.tsx",
    "project/[projectId]/improvement/fixes/[fixId]/simulations/[runId]/page.tsx",
    "project/[projectId]/tasks/[taskId]/scorers/[scorerId]/page.tsx",
  ]);
  const outside = pages(APP).filter(
    (path) =>
      !path.startsWith(join("(console)", "(evals)")) &&
      gated.some(
        (page) =>
          join("(console)", page) === path || join("(console)", "(stage-spine)", page) === path,
      ),
  );
  assert.deepEqual(outside, [], "no other route group serves an Evals path");
});
