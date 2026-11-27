import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { experimentHref, newEvalHref } from "../paths";

/**
 * The HTTP status of the pages of evals. Next commits to 200 when the first bytes of a page stream,
 * and answers 404 only when `notFound()` runs before that. So the test streams the real layouts and
 * loading boundaries above the page: the stream must break before its first byte.
 */
const APP = fileURLToPath(new URL("../../../../app", import.meta.url));
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_TEXT = "the page";
const PAGES = [
  "evals",
  "evals/cases/[caseId]",
  "evals/experiments/[experimentId]",
  "evals/experiments/[experimentId]/compare",
  "evals/[evalId]",
  "evals/new",
  "evals/experiments/[experimentId]/trials/[trialId]",
  "datasets",
  "datasets/[datasetId]",
];
const EXPERIMENT_ID = "22222222-2222-4222-8222-222222222222";

type Layout = (props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) => ReactNode | Promise<ReactNode>;

for (const name of PAGES) {
  test(`with the flag off ${name} answers 404: nothing streams before the flag is read`, async () => {
    delete process.env.FF_EVALS;
    const error = await streamPage(name).then(
      () => null,
      (reason: { digest?: string }) => reason,
    );
    assert.ok(error, "bytes were sent before the not-found, so the status is 200");
    if (!error.digest) throw error;
    assert.match(String(error.digest), /;404$/);
  });

  test(`with the flag off ${name} itself loads nothing: Next renders it next to its layout`, async () => {
    delete process.env.FF_EVALS;
    const { default: Page } = (await import(pathToFileURL(findPage(name)).href)) as {
      default: (props: { params: Promise<{ projectId: string }> }) => Promise<ReactNode>;
    };
    await assert.rejects(
      Page({
        params: Promise.resolve({ projectId: PROJECT_ID, caseId: "new", datasetId: EXPERIMENT_ID }),
      }),
      (error: { digest?: string }) => String(error.digest).endsWith(";404"),
    );
  });
}

test("old addresses redirect: a comparison and a suite run open the run, new opens the dialog", () => {
  // With the flag on, these pages only redirect: they read no data.
  const compare = readFileSync(findPage("evals/experiments/[experimentId]/compare"), "utf8");
  assert.match(compare, /notFound\(\);\s*redirect\(experimentHref\(projectId, experimentId\)\);/);
  const list = readFileSync(findPage("evals"), "utf8");
  assert.match(list, /if \(runId\) redirect\(experimentHref\(projectId, runId\)\);/);
  const create = readFileSync(findPage("evals/new"), "utf8");
  assert.match(create, /notFound\(\);\s*redirect\(newEvalHref\(projectId\)\);/);
  assert.equal(
    experimentHref(PROJECT_ID, EXPERIMENT_ID),
    `/project/${PROJECT_ID}/evals/experiments/${EXPERIMENT_ID}`,
  );
  assert.equal(newEvalHref(PROJECT_ID), `/project/${PROJECT_ID}/evals?new=1`);
});

/** The stream of the page inside its layouts. Rejects when no byte was sent before an error. */
async function streamPage(name: string) {
  let tree: ReactNode = PAGE_TEXT;
  for (const folder of foldersAbove(dirname(findPage(name)))) {
    if (existsSync(join(folder, "loading.tsx"))) {
      tree = createElement(Suspense, { fallback: "loading" }, tree);
    }
    const layout = join(folder, "layout.tsx");
    // The root layout is the html document of every page.
    if (folder === APP || !existsSync(layout)) continue;
    const { default: Layout } = (await import(pathToFileURL(layout).href)) as { default: Layout };
    const params = Promise.resolve({ projectId: PROJECT_ID });
    tree = createElement(Layout as never, { params }, tree);
  }
  return renderToReadableStream(tree, {
    onError: (error) => (error as { digest?: string }).digest,
  });
}

function findPage(name: string): string {
  const page = readdirSync(APP, { recursive: true, encoding: "utf8" }).find((file) =>
    file.endsWith(join("project", "[projectId]", name, "page.tsx")),
  );
  assert.ok(page);
  return join(APP, page);
}

/** From the folder of the page up to the app folder. */
function foldersAbove(folder: string): string[] {
  return relative(APP, folder) === "" ? [folder] : [folder, ...foldersAbove(dirname(folder))];
}
