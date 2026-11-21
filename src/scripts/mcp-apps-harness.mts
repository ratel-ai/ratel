/**
 * The MCP Apps dev harness: any view, with any of its fixtures, in light and
 * dark side by side, hosted by ext-apps' AppBridge. No server, no MCP host.
 *
 *   pnpm mcp-apps:dev              http://localhost:4180
 *   PORT=4200 pnpm mcp-apps:dev
 *
 * Each page load rebuilds the view, so editing a view or a DS component and
 * reloading shows the change. Fixtures are views/<view>/fixtures.ts.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { ViewFixtures } from "../mcp-apps/shell/types";
import type { HarnessConfig } from "../mcp-apps/harness/host";
import { buildView, listViews } from "@/scripts/build-mcp-apps.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4180);

async function hostScript(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(WEB, "mcp-apps", "harness", "host.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    logLevel: "silent",
  });
  return result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
}

async function fixturesFor(view: string): Promise<ViewFixtures> {
  const file = path.join(WEB, "mcp-apps", "views", view, "fixtures.ts");
  if (!existsSync(file)) return {};
  const imported = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { default: ViewFixtures | { default: ViewFixtures } };
  const value = imported.default as ViewFixtures & { default?: ViewFixtures };
  return value.default ?? value;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PAGE_STYLE = `
  body { margin: 0; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; background: #e9ecea; color: #111; }
  nav { padding: 10px 16px; background: #111614; color: #eef1ef; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  nav a { color: #eef1ef; } nav a.on { color: #ed5126; font-weight: 600; }
  #frames { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; padding: 16px; }
  .frame { border-radius: 10px; overflow: hidden; border: 1px solid #c9cfcc; }
  .frame header { padding: 6px 10px; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  .frame-dark { background: #1b1f1d; } .frame-dark header { color: #a9acaa; }
  .frame-light { background: #f4f5f4; } .frame-light header { color: #4b514e; }
  .frame-fullscreen { grid-column: 1 / -1; }
  .slot { padding: 12px; } iframe { width: 100%; border: 0; height: 320px; display: block; border-radius: 8px; }
  ol[data-log] { margin: 0; padding: 6px 10px 10px 28px; font: 11px ui-monospace, monospace; color: #888; max-height: 120px; overflow: auto; }
`;

async function viewPage(view: string, fixtureName: string | null, themes: Array<"light" | "dark">): Promise<string> {
  const [built, fixtures, script] = await Promise.all([buildView(view), fixturesFor(view), hostScript()]);
  const names = Object.keys(fixtures);
  const chosen = fixtureName && fixtures[fixtureName] ? fixtureName : names[0];
  const fixture = chosen ? fixtures[chosen] : { tool: view };
  const config: HarnessConfig = { view, html: built.html, frames: themes.map((theme) => ({ theme, fixture })) };
  const kb = (Buffer.byteLength(built.html) / 1024).toFixed(0);
  const links = names
    .map((name) => `<a class="${name === chosen ? "on" : ""}" href="/view/${view}?fixture=${encodeURIComponent(name)}">${escape(name)}</a>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(view)} · MCP Apps harness</title><style>${PAGE_STYLE}</style></head>
<body><nav><a href="/">views</a><strong>${escape(view)}</strong><span>${kb} KB</span>${links}</nav>
<div id="frames"></div>
<script type="application/json" id="harness-config">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
<script>${script}</script></body></html>`;
}

async function indexPage(): Promise<string> {
  const views = await listViews();
  const items = await Promise.all(
    views.map(async (view) => {
      const fixtures = Object.keys(await fixturesFor(view));
      const links = fixtures.map((name) => `<a href="/view/${view}?fixture=${encodeURIComponent(name)}">${escape(name)}</a>`).join(" · ");
      return `<li><a href="/view/${view}"><strong>${escape(view)}</strong></a> ${links}</li>`;
    }),
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>MCP Apps harness</title><style>${PAGE_STYLE} ul{padding:16px 32px}</style></head>
<body><nav><strong>MCP Apps harness</strong></nav><ul>${items.join("")}</ul></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  try {
    const match = url.pathname.match(/^\/view\/([a-z][a-z0-9-]*)$/);
    const theme = url.searchParams.get("theme");
    const themes: Array<"light" | "dark"> = theme === "light" || theme === "dark" ? [theme] : ["light", "dark"];
    const html = match ? await viewPage(match[1], url.searchParams.get("fixture"), themes) : url.pathname === "/" ? await indexPage() : null;
    if (html === null) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "content-type": "text/plain" }).end(String(error instanceof Error ? error.stack : error));
  }
});

server.listen(PORT, () => console.log(`mcp-apps harness: http://localhost:${PORT}`));
