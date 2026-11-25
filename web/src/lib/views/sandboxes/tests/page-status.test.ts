import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server.edge";

/**
 * The HTTP status of the sandbox page. Next commits to 200 when the first bytes of a page stream,
 * and answers 404 only when `notFound()` runs before that. So the test streams the real layouts and
 * loading boundaries above the page: the stream must break before its first byte.
 */
const APP = fileURLToPath(new URL("../../../../app", import.meta.url));
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_TEXT = "the sandbox page";

type Layout = (props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) => ReactNode | Promise<ReactNode>;

test("with the flag off the page answers 404: nothing streams before the flag is read", async () => {
  delete process.env.FF_SANDBOXES;
  const error = await streamPage().then(
    () => null,
    (reason: { digest?: string }) => reason,
  );
  assert.ok(error, "bytes were sent before the not-found, so the status is 200");
  if (!error.digest) throw error;
  assert.match(String(error.digest), /;404$/);
});

/** The stream of the page inside its layouts. Rejects when no byte was sent before an error. */
async function streamPage() {
  const page = readdirSync(APP, { recursive: true, encoding: "utf8" }).find((file) =>
    file.endsWith(join("project", "[projectId]", "sandbox", "page.tsx")),
  );
  assert.ok(page);
  let tree: ReactNode = PAGE_TEXT;
  for (const folder of foldersAbove(dirname(join(APP, page)))) {
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

/** From the folder of the page up to the app folder. */
function foldersAbove(folder: string): string[] {
  return relative(APP, folder) === "" ? [folder] : [folder, ...foldersAbove(dirname(folder))];
}
