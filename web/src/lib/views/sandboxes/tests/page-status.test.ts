import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { resetConfigForTests } from "@/config";

/**
 * The HTTP status of the sandbox page. Next commits to 200 when the first bytes of a page stream,
 * and answers 404 only when `notFound()` runs before that. So the test streams the real layouts and
 * loading boundaries above the page: the stream must break before its first byte.
 */
const APP = fileURLToPath(new URL("../../../../app", import.meta.url));
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_TEXT = "the sandbox page";
/** Each page of the Sandboxes area, from the project folder. */
const OLD_ADDRESS = join("sandbox", "route.ts");
const PAGES = [
  join("sandboxes", "page.tsx"),
  join("sandboxes", "[name]", "page.tsx"),
  join("sandboxes", "[name]", "versions", "page.tsx"),
  join("sandboxes", "[name]", "secrets", "page.tsx"),
  join("sandboxes", "[name]", "configuration", "page.tsx"),
];

type Layout = (props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) => ReactNode | Promise<ReactNode>;

test("with the flag off each Sandboxes page answers 404: nothing streams before the flag is read", async () => {
  delete process.env.FF_EVALS;
  for (const page of PAGES) {
    const error = await streamPage(page).then(
      () => null,
      (reason: { digest?: string }) => reason,
    );
    assert.ok(error, `${page}: bytes were sent before the not-found, so the status is 200`);
    if (!error.digest) throw error;
    assert.match(String(error.digest), /;404$/, page);
  }
});

test("with the flag off each Sandboxes page itself loads nothing: Next renders it next to its layout", async () => {
  delete process.env.FF_EVALS;
  for (const page of PAGES) {
    const { default: Page } = (await import(pathToFileURL(findPage(page)).href)) as {
      default: (props: {
        params: Promise<{ projectId: string; name: string }>;
        searchParams: Promise<Record<string, string>>;
      }) => Promise<ReactNode>;
    };
    await assert.rejects(
      Page({
        params: Promise.resolve({ projectId: PROJECT_ID, name: "support-demo" }),
        searchParams: Promise.resolve({}),
      }),
      (error: { digest?: string }) => String(error.digest).endsWith(";404"),
      page,
    );
  }
});

test("the old address of the sandbox page answers 307 to the Sandboxes list, and 404 with the flag off", async () => {
  const { GET } = (await import(pathToFileURL(findPage(OLD_ADDRESS)).href)) as {
    GET: (
      request: Request,
      context: { params: Promise<{ projectId: string }> },
    ) => Promise<Response>;
  };
  const call = () =>
    GET(new Request(`https://ratel.example/project/${PROJECT_ID}/sandbox`), {
      params: Promise.resolve({ projectId: PROJECT_ID }),
    });
  delete process.env.FF_EVALS;
  resetConfigForTests();
  assert.equal((await call()).status, 404);
  process.env.FF_EVALS = "1";
  resetConfigForTests();
  try {
    const answer = await call();
    assert.equal(answer.status, 307);
    assert.equal(
      answer.headers.get("location"),
      `https://ratel.example/project/${PROJECT_ID}/sandboxes`,
    );
  } finally {
    delete process.env.FF_EVALS;
    resetConfigForTests();
  }
});

/** The stream of the page inside its layouts. Rejects when no byte was sent before an error. */
async function streamPage(page: string) {
  let tree: ReactNode = PAGE_TEXT;
  for (const folder of foldersAbove(dirname(findPage(page)))) {
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

function findPage(page: string): string {
  const found = readdirSync(APP, { recursive: true, encoding: "utf8" }).find((file) =>
    file.endsWith(join("project", "[projectId]", page)),
  );
  assert.ok(found, page);
  return join(APP, found);
}

/** From the folder of the page up to the app folder. */
function foldersAbove(folder: string): string[] {
  return relative(APP, folder) === "" ? [folder] : [folder, ...foldersAbove(dirname(folder))];
}
