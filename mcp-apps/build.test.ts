import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildMcpAppCatalog } from "@/lib/mcp/apps/catalog";
import { defaultMcpAppLoadDeps, loadMcpAppCatalog } from "@/lib/mcp/apps/load";
import type { McpAppView } from "@/lib/mcp/apps/types";

/**
 * The built views (pnpm --filter @ratel/mcp-apps build, which `pnpm test` runs first): one
 * self-contained document each, within budget, and bindings the server accepts.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const VIEWS = path.join(HERE, "views");
/**
 * Our own guard against size regressions, not a host limit; a view may declare
 * more (budgetKb). 400 KB until RW-26 inlined Geist and Geist Mono (~62 KB of
 * base64) into every view; 470 KB until RW-42 compiled the console's own
 * app/globals.css (~17 KB more CSS) instead of a split-off ds.css.
 */
const BUDGET_BYTES = 490 * 1024;

const viewNames = readdirSync(VIEWS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

test("every view is built", () => {
  for (const view of viewNames)
    assert.ok(
      existsSync(path.join(DIST, `${view}.html`)),
      `${view}.html is missing: run pnpm --filter @ratel/mcp-apps build`,
    );
});

/**
 * Owned (ADR-0030): what a view may weigh here beyond its upstream budget. This workspace
 * resolves @base-ui/react 1.9 where upstream resolves 1.6, and the newer menu and dialog pull
 * its floating-ui hooks: about 25 KB more in the one view that renders both (list). Every view
 * also carries the settings' defaults (web/src/config-defaults.ts, the browser's config: about
 * 3 KB), which the list view, already at its limit, needs room for. The views' own bindings.ts
 * are copied, so the allowance lives here.
 */
const EDITION_EXTRA_KB: Readonly<Record<string, number>> = { list: 35 };

/** A view's own budget from its bindings.ts, or the default, plus this edition's allowance. */
function budgetOf(view: string): number {
  const source = readFileSync(path.join(VIEWS, view, "bindings.ts"), "utf8");
  const declared = source.match(/budgetKb:\s*(\d+)/);
  return (
    (declared ? Number(declared[1]) * 1024 : BUDGET_BYTES) + (EDITION_EXTRA_KB[view] ?? 0) * 1024
  );
}

for (const view of viewNames) {
  test(`${view}: one HTML file within its size budget that loads nothing from outside`, () => {
    const html = readFileSync(path.join(DIST, `${view}.html`), "utf8");
    const budget = budgetOf(view);
    assert.ok(
      Buffer.byteLength(html) < budget,
      `${view}.html is ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, over ${budget / 1024} KB`,
    );
    // Everything is inline: no tag fetches a file and no stylesheet loads a URL.
    assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, "an external script");
    assert.doesNotMatch(html, /<link[^>]+\bhref=/i, "an external stylesheet or font");
    assert.doesNotMatch(
      html,
      /<(img|iframe|source|video|audio)[^>]+\bsrc=["']?(https?:)?\/\//i,
      "an external media element",
    );
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1])
      .join("\n");
    assert.doesNotMatch(
      styles,
      /url\(\s*(?!["']?(?:data:|#))/i,
      "a stylesheet url() that is not inlined",
    );
    assert.doesNotMatch(styles, /@import/i, "a stylesheet @import");
  });
}

test("the replay leaves What if… to the console: its panel is a shim, its actions are not bundled", () => {
  const html = readFileSync(path.join(DIST, "replay.html"), "utf8");
  for (const action of ["submitWhatIfAction", "getWhatIfRunAction", "addWhatIfToEvalSetAction"]) {
    assert.equal(html.includes(action), false, `replay.html bundles ${action}`);
  }
});

/** Every source file under mcp-apps, shims excepted. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "dist" || entry.name === "shims" ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test("views reuse components/ds rather than copy it, and reach next/* only through the shims", () => {
  // Owned (ADR-0030): the design system is the workspace package here, not components/ds.
  const dsFiles = new Set(
    readdirSync(path.join(HERE, "..", "packages", "design-system", "src", "components")),
  );
  for (const file of sources(HERE)) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(HERE, file);
    assert.doesNotMatch(text, /from\s+["']next\//, `${relative} imports next/* directly`);
    assert.ok(
      !dsFiles.has(path.basename(file)) || relative.startsWith("views/"),
      `${relative} looks like a copy of components/ds/${path.basename(file)}`,
    );
  }
});

test("a console component a view imports keeps its Tailwind classes, whichever views build beside it", () => {
  // The health view imports components/health/v2/HealthScore.tsx, outside view.css's own sources;
  // the full build compiles every view at once, which once let one view's class scan stand in for another's.
  const html = readFileSync(path.join(DIST, "health.html"), "utf8");
  for (const rule of [".sm\\:flex-row", ".size-44", ".fill-accent-mark"])
    assert.ok(html.includes(rule), `health.html lacks ${rule}`);
});

test("views.json holds every published view and its bindings check against the registry", () => {
  const views = JSON.parse(readFileSync(path.join(DIST, "views.json"), "utf8")) as McpAppView[];
  for (const view of views) {
    assert.equal(
      view.html,
      readFileSync(path.join(DIST, `${view.view}.html`), "utf8"),
      `${view.view}: the served HTML is the built file`,
    );
  }
  // Throws on a binding to a tool the server does not register.
  buildMcpAppCatalog(views, defaultMcpAppLoadDeps.toolIds());
});

test("the server loads the built views and links the generic views' tools", () => {
  const catalog = loadMcpAppCatalog({
    ...defaultMcpAppLoadDeps,
    readViews: () =>
      JSON.parse(readFileSync(path.join(DIST, "views.json"), "utf8")) as McpAppView[],
  });
  assert.deepEqual(catalog.views.map((view) => view.view).sort(), [
    "detail",
    "health",
    "list",
    "replay",
    "series",
    "trace",
  ]);
  assert.equal(catalog.boundTool("list_traces")?.uri, "ui://ratel/list");
  assert.equal(catalog.boundTool("list_intents")?.uri, "ui://ratel/list");
  assert.equal(catalog.boundTool("get_trace")?.uri, "ui://ratel/trace");
  assert.equal(catalog.boundTool("get_cost_by_day")?.uri, "ui://ratel/series");
  assert.equal(catalog.boundTool("get_agent_health")?.uri, "ui://ratel/health");
  for (const tool of ["get_session", "get_run_summary", "get_trace_conversation"])
    assert.equal(catalog.boundTool(tool)?.uri, "ui://ratel/replay");
  for (const view of catalog.views) {
    for (const binding of view.bindings)
      assert.equal(
        catalog.boundTool(binding.tool)?.uri,
        `ui://ratel/${view.view}`,
        `${binding.tool} opens ${view.view}`,
      );
  }
});

test("every view carries Geist and Geist Mono inline and sits on the console's app surface, not the host's", () => {
  for (const view of viewNames) {
    const html = readFileSync(path.join(DIST, `${view}.html`), "utf8");
    for (const family of ["Geist", "Geist Mono"]) {
      assert.match(
        html,
        new RegExp(`@font-face\\{font-family:"${family}";[^}]*src:url\\(data:font/woff2;base64,`),
        `${view} lacks an inline ${family}`,
      );
    }
    assert.match(
      html,
      /--font-geist-sans:\s*"Geist"/,
      `${view} does not name Geist for --font-sans`,
    );
    assert.doesNotMatch(html, /--host-bg/, `${view} still reads the host's page color`);
    assert.match(
      html,
      /body\{background-color:var\(--ds-app\)/,
      `${view} lost the console's app surface`,
    );
  }
});

test("every view makes room for an open DS Panel in an inline frame (shell/view.css)", () => {
  for (const view of viewNames) {
    const html = readFileSync(path.join(DIST, `${view}.html`), "utf8");
    assert.match(
      html,
      /body:has\(\[role=dialog\]\)\{min-height:min\(34rem/,
      `${view} lost the open-panel min-height`,
    );
  }
});

test("a server action module a console component imports reaches a view as a stub, never its server code", async () => {
  const { isServerActionModule, serverActionStub } = await import("./scripts/build.mjs");
  const source =
    '"use server";\n\nimport { getDb } from "@/lib/platform/db/client";\nexport async function loadThing(id: string) { return getDb(); }\nexport type Thing = string;\n';
  assert.equal(isServerActionModule(source), true);
  assert.equal(isServerActionModule('/** doc */\n"use server";\nexport const x = 1;'), true);
  assert.equal(isServerActionModule('"use client";\nexport const x = 1;'), false);
  const stub = serverActionStub(source, path.join(HERE, "..", "web", "src", "lib", "x.ts"));
  assert.match(stub, /export async function loadThing\(\) \{ throw new Error/);
  assert.doesNotMatch(stub, /getDb|type Thing/);
  // The replay's inspector imports lib/session-chat/actions.ts as its default loader.
  const html = readFileSync(path.join(DIST, "replay.html"), "utf8");
  for (const server of ["drizzle", "getSessionContext", "statement_timeout"])
    assert.ok(!html.includes(server), `replay.html carries ${server}`);
});

test("the console's stylesheet does not scan mcp-apps/: its compiled CSS is what it is without the views", async () => {
  const web = path.join(HERE, "..", "web");
  const { default: postcss } = await import("postcss");
  const { default: tailwind } = await import("@tailwindcss/postcss");
  const { createRequire } = await import("node:module");
  // The plugins as Next loads them from postcss.config.mjs, in order.
  const { default: config } = (await import(path.join(web, "postcss.config.mjs"))) as {
    default: { plugins: Record<string, object> };
  };
  const names = Object.keys(config.plugins);
  assert.equal(names.length, 2);
  assert.match(names[0]!, /postcss-console-sources\.cjs$/);
  assert.equal(names[1], "@tailwindcss/postcss");
  const consoleSources = createRequire(import.meta.url)(names[0]!) as () => object;
  const from = path.join(web, "src", "app", "globals.css");
  const css = (
    await postcss([consoleSources() as never, tailwind({ base: web })]).process(
      readFileSync(from, "utf8"),
      { from },
    )
  ).css;
  // min-h-[32rem] is the session replay's (components/session-chat); shrink-[3] is only in the health view.
  assert.ok(css.includes(".min-h-\\[32rem\\]"), "the console's own classes are compiled");
  assert.equal(
    css.includes(".shrink-\\[3\\]"),
    false,
    "a class only a view uses stays out of the console's CSS",
  );
});

// Owned (ADR-0030): here the brand strings read the app's name from lib/platform/app-config.ts,
// which falls back to process.env outside the console's page. A view runs in a browser frame,
// where `process` does not exist: a bundle that still names it throws before it renders.
test("no view reaches for Node's process: it runs in a browser frame", () => {
  for (const view of viewNames) {
    const html = readFileSync(path.join(DIST, `${view}.html`), "utf8");
    const at = html.search(/\bprocess\.(env|cwd|platform|versions)\b/);
    assert.equal(
      at,
      -1,
      `${view}.html reads process: …${html.slice(Math.max(0, at - 80), at + 40)}…`,
    );
  }
});

test("an inlined bundle cannot end or derail its <script>: </script and <!-- are escaped, and still read the same", async () => {
  const { inlineScript } = await import("./scripts/build.mjs");
  const js = `var a="</script><!--<script>",b=/<!--/,c=\`</SCRIPT>\`;globalThis.out=[a,b.test("x<!--y"),c];`;
  const safe = inlineScript(js);
  assert.equal(/<\/script|<!--/i.test(safe), false);
  const scope: { out?: unknown[] } = {};
  new Function("globalThis", safe)(scope);
  assert.deepEqual(scope.out, ["</script><!--<script>", true, "</SCRIPT>"]);
});
