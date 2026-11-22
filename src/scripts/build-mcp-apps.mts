/**
 * Build every MCP Apps view into one self-contained HTML document.
 *
 *   pnpm mcp-apps:build            every view in mcp-apps/views
 *   pnpm mcp-apps:build list       only these views (the harness's fast path)
 *
 * A host loads a view into a sandboxed iframe whose CSP blocks the network by
 * default, so nothing may be fetched: esbuild bundles views/<view>/main.tsx
 * (React, the console's components/ds, the bridge) into one script, Tailwind v4
 * compiles the console's own stylesheet for the classes the view and the DS
 * use, and both are inlined, with Geist (geistFontFaces). next/link and
 * next/navigation resolve to the shims in mcp-apps/shell/shims, the only
 * next/* a view can reach.
 *
 * Writes mcp-apps/dist/<view>.html and mcp-apps/dist/views.json, the McpAppView[]
 * the MCP server serves (lib/mcp/apps). Bindings come from views/<view>/bindings.ts.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import subsetFont from "subset-font";
import type { McpAppView } from "../lib/mcp/apps/types";
import type { ViewBindings } from "../mcp-apps/shell/types";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(WEB, "mcp-apps");
const VIEWS = path.join(ROOT, "views");
const SHELL = path.join(ROOT, "shell");
export const DIST = path.join(ROOT, "dist");

export async function listViews(): Promise<string[]> {
  const entries = await readdir(VIEWS, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** A module whose first statement is the "use server" directive (a Next server action module). */
export function isServerActionModule(source: string): boolean {
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/.test(source);
}

/**
 * A server action module as a view sees it: each exported function rejects.
 * A console component may import an action as its default (the replay's step
 * inspector does, components/session-chat/step-content.ts); the view provides
 * its own through tools/call, and the action's server code (the database, auth)
 * never reaches the bundle.
 */
export function serverActionStub(source: string, file: string): string {
  const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  const where = path.relative(WEB, file);
  return names
    .map((name) => `export async function ${name}() { throw new Error(${JSON.stringify(`${name} (${where}) is a server action; an MCP view provides its own`)}); }`)
    .join("\n");
}

const serverActions: Plugin = {
  name: "server-action-stubs",
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!isServerActionModule(source)) return undefined;
      return { contents: serverActionStub(source, args.path), loader: "ts" };
    });
  },
};

/**
 * Console components a view never renders, swapped for a shim that keeps their
 * code out of the bundle: the replay's What if… (a view passes no `whatIf`).
 */
const CONSOLE_ONLY: Readonly<Record<string, string>> = {
  // Owned (ADR-0004): the panel lands in components/console here.
  [path.join(WEB, "components", "console", "session-replay", "WhatIfPanel")]: path.join(SHELL, "shims", "what-if-panel.tsx"),
};

const consoleOnly: Plugin = {
  name: "console-only-shims",
  setup(build) {
    build.onResolve({ filter: /WhatIfPanel$/ }, (args) => {
      const target = args.path.startsWith("@/") ? path.join(WEB, args.path.slice(2)) : path.resolve(args.resolveDir, args.path);
      const shim = CONSOLE_ONLY[target];
      return shim ? { path: shim } : undefined;
    });
  },
};

/**
 * The script, as one minified IIFE, and the plain CSS its modules import
 * (a DS component may import a stylesheet, as the dot loader does).
 */
export async function bundleScript(entry: string): Promise<{ script: string; importedCss: string; sources: string[] }> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: WEB,
    bundle: true,
    write: false,
    outdir: path.join(DIST, ".esbuild"),
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    jsx: "automatic",
    tsconfig: path.join(WEB, "tsconfig.json"),
    alias: {
      "next/link": path.join(SHELL, "shims", "next-link.tsx"),
      "next/navigation": path.join(SHELL, "shims", "next-navigation.ts"),
    },
    // Owned (ADR-0004): the brand strings read lib/platform/app-config.ts, which falls back to
    // process.env outside the console's page; a view's frame has no `process`, so it reads an
    // empty environment there and the app's default name.
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [consoleOnly, serverActions],
    metafile: true,
    logLevel: "silent",
  });
  // next/* is only reachable through the shims: the real package would pull a
  // router a view does not have, and its size.
  const leaked = Object.keys(result.metafile.inputs).filter((input) => /node_modules\/next\//.test(input));
  if (leaked.length > 0) throw new Error(`${entry} bundles Next itself (${leaked[0]}); import next/link or next/navigation, which the shims replace`);
  const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!js) throw new Error(`esbuild produced no script for ${entry}`);
  const css = result.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");
  return { script: inlineScript(js.text), importedCss: css, sources: tailwindSources(Object.keys(result.metafile.inputs)) };
}

/**
 * A bundle made safe to inline in <script>…</script>. A literal "</script"
 * inside a string would end the element; a literal "<!--" (followed later by
 * "<script") would put the parser in the script's double-escaped state and
 * swallow the closing tag. Both only occur inside string, template or regex
 * literals in a minified bundle, where `\/` and `\x3C` read the same.
 */
export function inlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "\\x3C!--");
}

/**
 * The app's own files a bundle took in beyond components/ds and mcp-apps
 * (which view.css already scans): a console component a view imports, such as
 * components/health/v2/HealthScore.tsx, keeps its Tailwind classes. Absolute
 * paths; esbuild names its inputs relative to `absWorkingDir` (WEB).
 */
export function tailwindSources(inputs: readonly string[]): string[] {
  return inputs
    .filter((input) => !input.includes("node_modules") && /\.(tsx|ts)$/.test(input))
    .map((input) => path.resolve(WEB, input))
    .filter((file) => file.startsWith(WEB + path.sep))
    .filter((file) => !file.startsWith(path.join(WEB, "mcp-apps") + path.sep) && !file.startsWith(path.join(WEB, "components", "ds") + path.sep))
    .sort();
}

/**
 * The console's stylesheet (app/globals.css) for the classes this view and
 * components/ds use, plus the view theme (light tokens). Fonts the console
 * serves from /fonts are dropped: nothing outside the document can load.
 */
export async function compileStyles(view: string, sources: readonly string[] = []): Promise<string> {
  const from = path.join(SHELL, "view.css");
  const extra = sources.map((file) => `@source "${path.relative(SHELL, file).split(path.sep).join("/")}";\n`).join("");
  const source = `${await readFile(from, "utf8")}\n@source "../views/${view}";\n${extra}`;
  // Tailwind's PostCSS plugin caches a compile by its input path: views built
  // side by side under one path would share each other's class scan. Each
  // view compiles as its own (virtual) file beside view.css, so @source paths
  // resolve the same.
  const result = await postcss([tailwind({ base: ROOT, optimize: { minify: true } })]).process(source, { from: path.join(SHELL, `view.${view}.css`) });
  return stripRemoteFonts(result.css);
}

/**
 * The Unicode ranges a view's Geist carries: Google Fonts' "latin" subset plus
 * the arrows, check and cross the views draw as text. Anything else (a CJK tool
 * name, an emoji in a message) falls back through --font-sans's own chain.
 */
export const GEIST_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x131, 0x131],
  [0x152, 0x153],
  [0x2bb, 0x2bc],
  [0x2c6, 0x2c6],
  [0x2da, 0x2da],
  [0x2dc, 0x2dc],
  [0x2000, 0x206f],
  [0x2074, 0x2074],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2190, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0x2713, 0x2713],
  [0x2715, 0x2715],
];

/** The weights the DS and the console components a view renders use: font-normal, -medium, -semibold. */
export const GEIST_WEIGHTS = { min: 400, max: 600 } as const;

const GEIST_FAMILIES = [
  { family: "Geist", file: "geist-sans/Geist-Variable.woff2" },
  { family: "Geist Mono", file: "geist-mono/GeistMono-Variable.woff2" },
] as const;

let geistCss: Promise<string> | null = null;

/**
 * Geist Sans and Geist Mono as @font-face rules with the font inlined (a view
 * fetches nothing), from the geist package app/layout.tsx loads through
 * next/font. Each variable font is cut to GEIST_RANGES and GEIST_WEIGHTS:
 * ~23 KB of woff2 a family instead of ~70 KB, ~62 KB of base64 for both.
 * Built once per run and shared by every view.
 */
export function geistFontFaces(): Promise<string> {
  geistCss ??= (async () => {
    const fonts = path.join(path.dirname(createRequire(import.meta.url).resolve("geist/font/sans")), "fonts");
    const text = GEIST_RANGES.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i))).join("");
    const unicodeRange = GEIST_RANGES.map(([from, to]) => (from === to ? `U+${hex(from)}` : `U+${hex(from)}-${hex(to)}`)).join(",");
    const rules = await Promise.all(
      GEIST_FAMILIES.map(async ({ family, file }) => {
        const font = await subsetFont(await readFile(path.join(fonts, file)), text, { targetFormat: "woff2", variationAxes: { wght: GEIST_WEIGHTS } });
        return `@font-face{font-family:"${family}";font-style:normal;font-weight:${GEIST_WEIGHTS.min} ${GEIST_WEIGHTS.max};font-display:block;src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");unicode-range:${unicodeRange}}`;
      }),
    );
    return rules.join("\n");
  })();
  return geistCss;
}

function hex(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, "0");
}

/** Drop @font-face rules whose src is a URL rather than inlined data. */
export function stripRemoteFonts(css: string): string {
  return css.replace(/@font-face\s*{[^}]*}/g, (rule) => (/url\(\s*(?!["']?data:)/.test(rule) ? "" : rule));
}

export function htmlDocument({ title, script, styles }: { title: string; script: string; styles: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en" data-theme="dark">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title.replace(/[<&]/g, "")}</title>`,
    `<style>${styles.replace(/<\/style/gi, "<\\/style")}</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export async function buildView(view: string): Promise<McpAppView> {
  const dir = path.join(VIEWS, view);
  const imported = (await import(pathToFileURL(path.join(dir, "bindings.ts")).href)) as { default: ViewBindings | { default: ViewBindings } };
  // tsx hands a .ts default export to an ESM importer either as is or wrapped once.
  const declared: ViewBindings = "bindings" in imported.default ? imported.default : imported.default.default;
  const { script, importedCss, sources } = await bundleScript(path.join(dir, "main.tsx"));
  const [compiled, fonts] = await Promise.all([compileStyles(view, sources), geistFontFaces()]);
  const styles = `${fonts}\n${compiled}\n${stripRemoteFonts(importedCss)}`;
  const title = declared.title ?? view;
  return {
    view,
    title,
    ...(declared.description ? { description: declared.description } : {}),
    html: htmlDocument({ title, script, styles }),
    bindings: declared.bindings,
  };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const views = only.length > 0 ? only : await listViews();
  const started = Date.now();
  const built = await Promise.all(views.map(buildView));
  await mkdir(DIST, { recursive: true });
  await Promise.all(built.map((view) => writeFile(path.join(DIST, `${view.view}.html`), view.html)));
  if (only.length === 0) {
    await writeFile(path.join(DIST, "views.json"), `${JSON.stringify(built)}\n`);
  }
  for (const view of built) {
    console.log(`mcp-apps: ${view.view} ${(Buffer.byteLength(view.html) / 1024).toFixed(0)} KB, ${view.bindings.length} bindings`);
  }
  console.log(`mcp-apps: built ${built.length} views in ${Date.now() - started} ms`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
