// CommonJS on purpose: Next loads PostCSS plugins with require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

/**
 * Keeps the MCP Apps views' sources (mcp-apps/) out of the console's Tailwind
 * scan, so the console's compiled CSS is exactly what it is without them.
 *
 * Tailwind finds a stylesheet's classes by scanning every source under the
 * project, mcp-apps/ included. The views compile app/globals.css themselves
 * (scripts/build-mcp-apps.mts, which calls PostCSS directly and never reads
 * this config) with their own sources, so the exclusion cannot live in
 * globals.css: there it would strip the views' classes too. Here it applies to
 * Next's build of app/globals.css alone, ahead of @tailwindcss/postcss.
 */
const consoleSources = () => ({
  postcssPlugin: "ratel-console-sources",
  Once(root, { result, AtRule }) {
    const from = result.opts.from ?? "";
    if (!from.endsWith(path.join("app", "globals.css"))) return;
    root.append(new AtRule({ name: "source", params: 'not "../mcp-apps"' }));
  },
});
consoleSources.postcss = true;

module.exports = consoleSources;
