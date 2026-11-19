import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The console-sources plugin as an absolute path: Next requires plugins by
 * name, from its own build directory. Beside this file, wherever the build is
 * run from. The working directory (apps/web for every script here) is the
 * fallback, for a bundler that evaluates this config from a copy elsewhere.
 */
function consoleSourcesPlugin() {
  const name = "postcss-console-sources.cjs";
  try {
    const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), name);
    if (existsSync(beside)) return beside;
  } catch {
    // Not a file URL: evaluated from a bundle.
  }
  return path.join(process.cwd(), name);
}

const config = {
  plugins: {
    // Before Tailwind: the console's stylesheet does not scan mcp-apps/ (see the file).
    [consoleSourcesPlugin()]: {},
    "@tailwindcss/postcss": {},
  },
};

export default config;
