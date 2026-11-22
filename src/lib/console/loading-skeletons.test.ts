import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectRouteSkeleton } from "@/components/console/calibration/ProjectRouteSkeleton";
import { CatalogSkeleton } from "@/components/console/catalog/CatalogSkeleton";
import { OrgSkeleton } from "@/components/console/org/OrgSkeleton";

/**
 * Upstream's loading skeletons for the catalogs, the playground, trace compare and the
 * organization's MCP page: each route draws a skeleton in its own page's shape while it loads,
 * instead of the project overview's (or nothing).
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), "../../app/(console)");

function markup(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

test("the catalog explorer's skeleton draws the tree beside the detail", () => {
  const html = markup(createElement(CatalogSkeleton, { variant: "explorer" }));
  assert.match(html, /role="status"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Loading catalog…/);
  assert.match(html, /w-80 shrink-0/, "the tree column");
  assert.doesNotMatch(html, /lg:grid-cols-4/, "no numbers row");
});

test("the catalog table's skeleton draws four numbers above ten rows", () => {
  const html = markup(createElement(CatalogSkeleton, { variant: "table" }));
  assert.match(html, /Loading catalog…/);
  assert.match(html, /lg:grid-cols-4/);
  assert.equal(count(html, "flex h-24 flex-col"), 4, "four numbers");
  assert.equal(count(html, "flex h-9 items-center"), 10, "ten rows");
  assert.doesNotMatch(html, /w-80 shrink-0/, "no tree");
});

test("the organization integrations skeleton draws a header with a description, and its two sections", () => {
  const html = markup(createElement(OrgSkeleton, { variant: "integrations" }));
  assert.match(html, /role="status"/);
  assert.match(html, /Loading…/);
  assert.match(html, /w-96 max-w-full/, "the connect picker");
  assert.match(html, /h-48 w-full/, "the example panel");
  assert.notEqual(
    html,
    markup(createElement(OrgSkeleton, { variant: "integrations", body: true })),
    "the page form draws its header",
  );
});

const ROUTES: Array<{ route: string; expected: ReactElement }> = [
  {
    route: "project/[projectId]/catalogs",
    expected: createElement(CatalogSkeleton, { variant: "explorer" }),
  },
  {
    route: "project/[projectId]/catalogs/tools",
    expected: createElement(CatalogSkeleton, { variant: "table" }),
  },
  {
    route: "project/[projectId]/catalogs/skills",
    expected: createElement(CatalogSkeleton, { variant: "table" }),
  },
  {
    route: "project/[projectId]/playground",
    expected: createElement(ProjectRouteSkeleton, { variant: "detail" }),
  },
  {
    route: "project/[projectId]/traces/compare",
    expected: createElement(ProjectRouteSkeleton, { variant: "detail" }),
  },
  {
    route: "org/[orgSlug]/mcp",
    expected: createElement(OrgSkeleton, { variant: "integrations" }),
  },
];

for (const { route, expected } of ROUTES) {
  test(`${route} has a loading.tsx that draws its own page's skeleton`, async () => {
    const file = join(APP, route, "loading.tsx");
    assert.ok(existsSync(file), `${route}/loading.tsx exists`);
    const loading = (await import(file)) as { default: () => ReactElement };
    assert.equal(markup(loading.default()), markup(expected));
  });
}
